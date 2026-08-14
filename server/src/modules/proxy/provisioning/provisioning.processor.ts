import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import os from 'node:os';
import type { ProviderInstance } from '../provider/compute-provider';
import { ProviderRegistry } from '../provider/provider.registry';
import { ProxyCredentialService } from '../proxy-credential.service';
import { ProxySecretService } from '../proxy-secret.service';
import { ProxyService } from '../proxy.service';
import { SocksHealthService } from '../gost/socks-health.service';
import { ProvisioningRepository, type ProvisioningJob } from './provisioning.repository';

@Injectable()
export class ProvisioningProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProvisioningProcessor.name);
  private readonly workerId = `${os.hostname()}:${process.pid}`;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private active = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly repository: ProvisioningRepository,
    private readonly providers: ProviderRegistry,
    private readonly credentials: ProxyCredentialService,
    private readonly secrets: ProxySecretService,
    private readonly proxy: ProxyService,
    private readonly health: SocksHealthService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get<string>('PROXY_PROVISIONING_ENABLED') !== 'true') {
      this.logger.warn('Automatic proxy provisioning is disabled');
      return;
    }
    this.logger.log(`Provisioning processor started as ${this.workerId}`);
    void this.start();
  }

  onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async start() {
    await this.reconcileProviders();
    if (this.stopped) return;
    this.timer = setInterval(() => void this.tick(), Number(this.config.get('PROXY_PROVISIONING_POLL_MS') || 2000));
    void this.tick();
  }

  private async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const concurrency = Math.max(1, Number(this.config.get('PROXY_PROVISIONING_CONCURRENCY') || 2));
      while (this.active < concurrency && !this.stopped) {
        const job = await this.repository.claim(this.workerId, 180);
        if (!job) break;
        this.active += 1;
        void this.process(job).finally(() => { this.active -= 1; });
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : error);
    } finally {
      this.ticking = false;
    }
  }

  private async process(job: ProvisioningJob) {
    let instance: ProviderInstance | null = null;
    let providerId: number | null = null;
    let providerApiKey = '';
    let providerDriver = '';
    const leaseHeartbeat = setInterval(() => {
      void this.repository.renewLease(job.id, this.workerId, 180).then(owned => {
        if (!owned) this.logger.error(`Lost provisioning lease for job ${job.id}`);
      }).catch(error => this.logger.error(`Could not renew job ${job.id}: ${error instanceof Error ? error.message : error}`));
    }, 60_000);
    try {
      const context = await this.repository.context(job.node_id);
      const capacity = await this.repository.reserveCapacity(context.nodeId, this.workerId);
      providerId = capacity.providerId;
      const firstPort = Number(this.config.get('GOST_TUNNEL_PORT_MIN') || 30000);
      const lastPort = Number(this.config.get('GOST_TUNNEL_PORT_MAX') || 39999);
      const publicHost = String(this.config.get('GOST_PUBLIC_HOST') || this.required('GOST_MASTER_HOST'));
      const endpoint = await this.repository.allocateTunnelEndpoint(
        context.nodeId,
        this.workerId,
        publicHost,
        firstPort,
        lastPort,
      );
      const providerConfig = await this.repository.provider(capacity.providerId, capacity.apiKeyId);
      providerDriver = providerConfig.driver;
      providerApiKey = this.secrets.decryptProviderKey(providerConfig.key);
      const provider = this.providers.get(providerDriver);
      const accountCredential = await this.credentials.getOrCreate(context.profileId);
      await this.repository.assignProvider(context.nodeId, capacity.providerId, capacity.apiKeyId);
      await this.proxy.reportStatus(context.nodeId, { status: 'provisioning' });

      const ttlMinutes = Math.max(15, Number(this.config.get('E2B_SANDBOX_TIMEOUT_MINUTES') || 60));
      const renewBeforeMinutes = Math.max(1, Math.min(ttlMinutes - 1, Number(this.config.get('E2B_RENEW_BEFORE_MINUTES') || 10)));
      const sandboxExpiresAt = new Date(Date.now() + ttlMinutes * 60000);
      const nextRotationAt = new Date(sandboxExpiresAt.getTime() - renewBeforeMinutes * 60000);
      const tunnelUsername = this.required('GOST_TUNNEL_USERNAME');
      const tunnelPassword = this.required('GOST_TUNNEL_PASSWORD');

      instance = await provider.provisionNode({
        nodeId: context.nodeId,
        orderId: context.orderId,
        providerApiKey,
        template: String(providerConfig.metadata.template || this.config.get('E2B_TEMPLATE') || '') || undefined,
        timeoutMs: ttlMinutes * 60000,
        expiresAt: sandboxExpiresAt,
        metadata: { service: 'socks5' },
        gost: {
          version: String(this.config.get('GOST_VERSION') || '2.12.0'),
          localPort: Number(this.config.get('GOST_LOCAL_SOCKS_PORT') || 1080),
          publicHost: endpoint.publicHost,
          bindPort: endpoint.tunnelPort,
          masterHost: String(this.config.get('GOST_MASTER_HOST') || endpoint.publicHost),
          rendezvousPort: Number(this.config.get('GOST_RENDEZVOUS_PORT') || 28443),
          tunnelTransport: this.tunnelTransport(),
          tunnelUsername,
          tunnelPassword,
          socksUsername: accountCredential.username,
          socksPassword: accountCredential.password,
        },
      });

      await this.repository.recordInstance({
        nodeId: context.nodeId,
        providerId: capacity.providerId,
        apiKeyId: capacity.apiKeyId,
        externalInstanceId: instance.externalInstanceId,
        expiresAt: sandboxExpiresAt,
      });
      await this.health.waitUntilReady(endpoint.publicHost, endpoint.tunnelPort, accountCredential.username, accountCredential.password);
      await this.repository.complete({
        jobId: job.id,
        workerId: this.workerId,
        externalInstanceId: instance.externalInstanceId,
        egressIp: instance.egressIp || null,
        publicHost: endpoint.publicHost,
        tunnelPort: endpoint.tunnelPort,
        nextRotationAt,
      });
      this.logger.log(`Node ${context.nodeId} provisioned on ${providerDriver}/${instance.externalInstanceId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (instance && providerApiKey && providerDriver) {
        const terminated = await this.providers.get(providerDriver).terminateInstance(instance.externalInstanceId, providerApiKey)
          .then(() => true).catch(() => false);
        if (providerId) await this.repository.markInstanceStopped(providerId, instance.externalInstanceId, terminated ? 'stopped' : 'error').catch(() => undefined);
      }
      await this.repository.fail(job.id, this.workerId, message, Math.min(300, 15 * 2 ** Math.max(0, job.attempts - 1))).catch(failError =>
        this.logger.error(`Could not record failure for job ${job.id}: ${failError instanceof Error ? failError.message : failError}`)
      );
      this.logger.warn(`Provisioning job ${job.id} failed: ${message}`);
    } finally {
      clearInterval(leaseHeartbeat);
    }
  }

  private async reconcileProviders() {
    try {
      const targets = await this.repository.reconciliationTargets();
      for (const target of targets) {
        const providerRow = Array.isArray(target.proxy_providers) ? target.proxy_providers[0] : target.proxy_providers;
        const driver = String(providerRow?.metadata?.driver || providerRow?.code || '');
        if (!this.providers.supports(driver)) continue;
        const apiKey = this.secrets.decryptProviderKey(target);
        const provider = this.providers.get(driver);
        const [owned, tracked] = await Promise.all([
          provider.listOwnedInstances(apiKey),
          this.repository.trackedInstances(Number(target.provider_id), Number(target.id)),
        ]);
        const ownedIds = new Set(owned.map(instance => instance.externalInstanceId));
        const trackedIds = new Set(tracked.map(instance => instance.external_instance_id));

        for (const instance of owned) {
          const oldEnoughToBeOrphan = !instance.startedAt || Date.now() - instance.startedAt.getTime() > 5 * 60_000;
          if (!trackedIds.has(instance.externalInstanceId) && oldEnoughToBeOrphan) {
            this.logger.warn(`Terminating untracked ${driver} sandbox ${instance.externalInstanceId}`);
            await provider.terminateInstance(instance.externalInstanceId, apiKey).catch(error =>
              this.logger.error(`Unable to terminate orphan ${instance.externalInstanceId}: ${error instanceof Error ? error.message : error}`));
          }
        }
        for (const instance of tracked) {
          if (!ownedIds.has(instance.external_instance_id)) {
            await this.repository.markInstanceStopped(Number(target.provider_id), instance.external_instance_id, 'error');
          }
        }
      }
    } catch (error) {
      this.logger.error(`Provider reconciliation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private required(key: string) {
    const value = this.config.get<string>(key);
    if (!value) throw new Error(`${key} is required for proxy provisioning`);
    return value;
  }

  private tunnelTransport(): 'tcp' | 'ws' | 'wss' {
    const value = String(this.config.get('GOST_TUNNEL_TRANSPORT') || 'tcp');
    if (!['tcp', 'ws', 'wss'].includes(value)) throw new Error('GOST_TUNNEL_TRANSPORT must be tcp, ws, or wss');
    return value as 'tcp' | 'ws' | 'wss';
  }
}
