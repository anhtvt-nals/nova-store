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
  private rotationTimer?: NodeJS.Timeout;
  private expirationTimer?: NodeJS.Timeout;
  private retentionTimer?: NodeJS.Timeout;
  private ticking = false;
  private schedulingRotations = false;
  private schedulingExpirations = false;
  private purgingRuntimeHistory = false;
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
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    if (this.expirationTimer) clearInterval(this.expirationTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
  }

  private async start() {
    await this.reconcileProviders();
    if (this.stopped) return;
    await this.scheduleExpiredOrders();
    if (this.stopped) return;
    await this.scheduleDueRotations();
    if (this.stopped) return;
    await this.purgeRuntimeHistory();
    if (this.stopped) return;
    const expirationPollMs = Math.max(5000, Number(this.config.get('PROXY_EXPIRATION_POLL_MS') || 30000));
    const rotationPollMs = Math.max(5000, Number(this.config.get('PROXY_ROTATION_POLL_MS') || 30000));
    this.expirationTimer = setInterval(() => void this.scheduleExpiredOrders(), expirationPollMs);
    this.rotationTimer = setInterval(() => void this.scheduleDueRotations(), rotationPollMs);
    const retentionPollMs = Math.max(60_000, Number(this.config.get('PROXY_RUNTIME_RETENTION_POLL_MS') || 6 * 60 * 60_000));
    this.retentionTimer = setInterval(() => void this.purgeRuntimeHistory(), retentionPollMs);
    this.timer = setInterval(() => void this.tick(), Number(this.config.get('PROXY_PROVISIONING_POLL_MS') || 2000));
    void this.tick();
  }

  private async scheduleExpiredOrders() {
    if (this.schedulingExpirations || this.stopped) return;
    this.schedulingExpirations = true;
    try {
      const configuredBatchSize = Number(this.config.get('PROXY_EXPIRATION_BATCH_SIZE') || 100);
      const batchSize = Math.max(1, Math.min(500, Number.isFinite(configuredBatchSize) ? configuredBatchSize : 100));
      const scheduled = await this.repository.enqueueExpiredTerminations(batchSize);
      if (scheduled.length > 0) {
        this.logger.log(`Scheduled cleanup for ${scheduled.length} expired proxy node${scheduled.length === 1 ? '' : 's'}`);
      }
    } catch (error) {
      this.logger.error(`Unable to schedule expired order cleanups: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.schedulingExpirations = false;
    }
  }

  private async scheduleDueRotations() {
    if (this.schedulingRotations || this.stopped) return;
    this.schedulingRotations = true;
    try {
      // A replacement needs temporary provider headroom. Queue one by default
      // so a due batch never makes every healthy node look unavailable.
      const configuredBatchSize = Number(this.config.get('PROXY_ROTATION_BATCH_SIZE') || 1);
      const batchSize = Math.max(1, Math.min(500, Number.isFinite(configuredBatchSize) ? configuredBatchSize : 1));
      const recovered = await this.repository.recoverStalledRotations(batchSize);
      if (recovered.length > 0) {
        this.logger.warn(`Recovered ${recovered.length} stalled proxy rotation${recovered.length === 1 ? '' : 's'}`);
      }
      const scheduled = await this.repository.enqueueDueRotations(batchSize);
      if (scheduled.length > 0) {
        this.logger.log(`Scheduled ${scheduled.length} due proxy rotation${scheduled.length === 1 ? '' : 's'}`);
      }
    } catch (error) {
      this.logger.error(`Unable to schedule due proxy rotations: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.schedulingRotations = false;
    }
  }

  private async purgeRuntimeHistory() {
    if (this.purgingRuntimeHistory || this.stopped) return;
    this.purgingRuntimeHistory = true;
    try {
      const readInteger = (key: string, fallback: number, min: number, max: number) => {
        const value = Number(this.config.get(key) || fallback);
        return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : fallback));
      };
      const result = await this.repository.purgeRuntimeHistory(
        readInteger('PROXY_INSTANCE_RETENTION_DAYS', 14, 1, 365),
        readInteger('PROXY_LEASE_RETENTION_DAYS', 7, 1, 365),
        readInteger('PROXY_RUNTIME_RETENTION_BATCH_SIZE', 500, 1, 5000),
      );
      if (result.instances || result.leases) this.logger.log(`Purged ${result.instances} historical proxy instance(s) and ${result.leases} released capacity lease(s)`);
    } catch (error) {
      this.logger.error(`Unable to purge proxy runtime history: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.purgingRuntimeHistory = false;
    }
  }

  private async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const concurrency = Math.max(1, Number(this.config.get('PROXY_PROVISIONING_CONCURRENCY') || 2));
      while (this.active < concurrency && !this.stopped) {
        const job = await this.repository.claim(this.workerId, this.provisioningLockSeconds());
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
    const lockSeconds = this.provisioningLockSeconds();
    const leaseHeartbeat = setInterval(() => {
      void this.repository.renewLease(job.id, this.workerId, lockSeconds).then(owned => {
        if (!owned) this.logger.error(`Lost provisioning lease for job ${job.id}`);
      }).catch(error => this.logger.error(`Could not renew job ${job.id}: ${error instanceof Error ? error.message : error}`));
    }, Math.max(10_000, Math.floor(lockSeconds * 500)));
    try {
      if (job.action === 'terminate') {
        await this.terminate(job);
        return;
      }
      const replacing = job.action === 'replace';
      const context = await this.repository.context(job.node_id, job.action);
      const capacity = await this.repository.reserveCapacity(context.nodeId, this.workerId, replacing ? 'replacement' : 'customer');
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
      const accountCredential = await this.credentials.getOrCreate(context.profileId);

      if (replacing && context.currentInstanceId) {
        // Do not show ROTATING while this replacement waits for capacity. The
        // old endpoint remains usable until we actually begin the cutover.
        await this.proxy.reportStatus(context.nodeId, { status: 'rotating' });
        if (!context.providerId || !context.providerApiKeyId) throw new Error('Existing proxy instance has no provider assignment');
        const oldProviderConfig = await this.repository.providerForTermination(context.providerId, context.providerApiKeyId);
        const oldProviderApiKey = this.secrets.decryptProviderKey(oldProviderConfig.key);
        const oldProvider = this.providers.get(oldProviderConfig.driver);
        await oldProvider.terminateInstance(context.currentInstanceId, oldProviderApiKey);
        await this.repository.markInstanceStopped(context.providerId, context.currentInstanceId, 'stopped');
        await this.repository.clearReplacedInstance(context.nodeId, context.currentInstanceId);
        await this.health.waitUntilUnavailable(endpoint.publicHost, endpoint.tunnelPort, accountCredential.username, accountCredential.password);
      }
      if (replacing) await this.repository.releaseCustomerCapacity(context.nodeId);

      const providerConfig = await this.repository.provider(capacity.providerId, capacity.apiKeyId);
      providerDriver = providerConfig.driver;
      providerApiKey = this.secrets.decryptProviderKey(providerConfig.key);
      const provider = this.providers.get(providerDriver);
      if (!replacing) {
        await this.repository.assignProvider(context.nodeId, capacity.providerId, capacity.apiKeyId);
        await this.proxy.reportStatus(context.nodeId, { status: 'provisioning' });
      }

      // Runloop is a separate provider: it always uses an X_SMALL Devbox with
      // a one-hour TTL. E2B retains its existing configuration unchanged.
      const ttlMinutes = ['runloop', 'github'].includes(providerDriver)
        ? 60
        : Math.max(15, Number(this.config.get('E2B_SANDBOX_TIMEOUT_MINUTES') || 60));
      const renewBeforeMinutes = Math.max(1, Math.min(ttlMinutes - 1, Number(this.config.get('E2B_RENEW_BEFORE_MINUTES') || 10)));
      const sandboxExpiresAt = new Date(Date.now() + ttlMinutes * 60000);
      const nextRotationAt = new Date(sandboxExpiresAt.getTime() - renewBeforeMinutes * 60000);
      const tunnelUsername = this.required('GOST_TUNNEL_USERNAME');
      const tunnelPassword = this.required('GOST_TUNNEL_PASSWORD');

      instance = await provider.provisionNode({
        nodeId: context.nodeId,
        orderId: context.orderId,
        providerApiKeyId: capacity.apiKeyId,
        providerApiKey,
        template: String(providerConfig.metadata.template || (providerDriver === 'runloop' ? this.config.get('RUNLOOP_BLUEPRINT') : this.config.get('E2B_TEMPLATE')) || '') || undefined,
        timeoutMs: ttlMinutes * 60000,
        expiresAt: sandboxExpiresAt,
        metadata: { service: 'socks5' },
        gost: {
          version: String(this.config.get('GOST_VERSION') || '3.2.6'),
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
          bandwidthIn: this.bandwidthLimit('GOST_NODE_BANDWIDTH_IN'),
          bandwidthOut: this.bandwidthLimit('GOST_NODE_BANDWIDTH_OUT'),
          maxConnections: this.maxConnections(),
        },
      });

      await this.repository.recordInstance({
        nodeId: context.nodeId,
        providerId: capacity.providerId,
        apiKeyId: capacity.apiKeyId,
        externalInstanceId: instance.externalInstanceId,
        expiresAt: sandboxExpiresAt,
      });
      const configuredReplacementTimeout = Number(this.config.get('GOST_REPLACEMENT_READY_TIMEOUT_MS') || 60000);
      const githubReadyTimeout = Math.max(60_000, Math.min(10 * 60_000, Number(this.config.get('GITHUB_READY_TIMEOUT_MS') || 180_000)));
      const readyTimeout = providerDriver === 'github'
        ? githubReadyTimeout
        : replacing ? Math.max(20000, Math.min(120000, configuredReplacementTimeout || 60000)) : 20000;
      await this.health.waitUntilReady(endpoint.publicHost, endpoint.tunnelPort, accountCredential.username, accountCredential.password, readyTimeout);
      if (replacing) {
        await this.repository.completeReplacement({
          jobId: job.id,
          workerId: this.workerId,
          externalInstanceId: instance.externalInstanceId,
          egressIp: instance.egressIp || null,
          nextRotationAt,
        });
      } else {
        await this.repository.complete({
          jobId: job.id,
          workerId: this.workerId,
          externalInstanceId: instance.externalInstanceId,
          egressIp: instance.egressIp || null,
          publicHost: endpoint.publicHost,
          tunnelPort: endpoint.tunnelPort,
          nextRotationAt,
        });
      }
      this.logger.log(`Node ${context.nodeId} ${replacing ? 'replaced' : 'provisioned'} on ${providerDriver}/${instance.externalInstanceId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (instance && providerApiKey && providerDriver) {
        const terminated = await this.providers.get(providerDriver).terminateInstance(instance.externalInstanceId, providerApiKey)
          .then(() => true).catch(() => false);
        if (providerId) await this.repository.markInstanceStopped(providerId, instance.externalInstanceId, terminated ? 'stopped' : 'error').catch(() => undefined);
      }
      const delaySeconds = Math.min(300, 15 * 2 ** Math.max(0, job.attempts - 1));
      const recordFailure = job.action === 'terminate'
        ? this.repository.failTermination(job.id, this.workerId, message, delaySeconds)
        : job.action === 'replace'
          ? this.repository.failReplacement(job.id, this.workerId, message, delaySeconds)
          : this.repository.fail(job.id, this.workerId, message, delaySeconds);
      await recordFailure.catch(failError =>
        this.logger.error(`Could not record failure for job ${job.id}: ${failError instanceof Error ? failError.message : failError}`)
      );
      this.logger.warn(`Provisioning job ${job.id} failed: ${message}`);
    } finally {
      clearInterval(leaseHeartbeat);
    }
  }

  private async terminate(job: ProvisioningJob) {
    const context = await this.repository.terminationContext(job.node_id);
    if (context.currentInstanceId) {
      if (!context.providerId || !context.providerApiKeyId) {
        throw new Error('Existing proxy instance has no provider assignment');
      }
      const providerConfig = await this.repository.providerForTermination(context.providerId, context.providerApiKeyId);
      const providerApiKey = this.secrets.decryptProviderKey(providerConfig.key);
      await this.providers.get(providerConfig.driver).terminateInstance(context.currentInstanceId, providerApiKey);
      await this.repository.markInstanceStopped(context.providerId, context.currentInstanceId, 'stopped');
    }
    await this.repository.completeTermination(job.id, this.workerId);
    this.logger.log(`Expired proxy node ${context.nodeId} terminated`);
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
            try {
              await provider.terminateInstance(instance.externalInstanceId, apiKey);
              await this.repository.markInstanceStopped(Number(target.provider_id), instance.externalInstanceId, 'stopped');
            } catch (error) {
              this.logger.error(`Unable to terminate orphan ${instance.externalInstanceId}: ${error instanceof Error ? error.message : error}`);
            }
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

  private bandwidthLimit(key: string) {
    const value = String(this.config.get(key) || '').trim().toUpperCase();
    if (!value) return null;
    if (!/^[1-9]\d*(B|KB|MB|GB|TB)$/.test(value)) {
      throw new Error(`${key} must be a positive bandwidth such as 10MB`);
    }
    return value;
  }

  private maxConnections() {
    const value = Number(this.config.get('GOST_NODE_MAX_CONNECTIONS') || 0);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('GOST_NODE_MAX_CONNECTIONS must be a non-negative integer');
    }
    return value > 0 ? value : null;
  }

  private provisioningLockSeconds() {
    const value = Number(this.config.get('PROXY_PROVISIONING_LOCK_SECONDS') || 60);
    if (!Number.isFinite(value)) return 60;
    return Math.max(30, Math.min(300, Math.floor(value)));
  }
}
