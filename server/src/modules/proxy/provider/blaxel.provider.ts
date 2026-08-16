import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../database/database.service';
import { GostCommandBuilder } from '../gost/gost-command.builder';
import type { ComputeProvider, ProviderInstance, ProvisionNodeInput } from './compute-provider';

type BlaxelSandbox = {
  metadata?: { name?: string; url?: string; labels?: Record<string, string>; createdAt?: string };
  status?: string;
  state?: string;
  expiresIn?: number;
};

@Injectable()
export class BlaxelProvider implements ComputeProvider {
  readonly type = 'blaxel';
  readonly capabilities = { executionMode: 'sandbox' as const, supportsInteractiveExec: true, supportsLongRunning: true, supportsOutboundTcp: true, supportsLifetimeExtension: false, supportsCustomImage: true, maxRuntimeSeconds: 86400 };
  private readonly logger = new Logger(BlaxelProvider.name);

  constructor(
    private readonly gost: GostCommandBuilder,
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  async provisionNode(input: ProvisionNodeInput): Promise<ProviderInstance> {
    const { workspace, apiKey } = this.parseKey(input.providerApiKey);
    const name = `nodenesia-proxy-${input.nodeId}-${Date.now().toString(36)}`;
    const image = input.template || String(this.config.get('BLAXEL_IMAGE') || 'blaxel/base-image:latest');
    const target = await this.selectTarget(input.nodeId, input.providerApiKeyId);
    this.logger.log(`Provisioning proxy node ${input.nodeId} in Blaxel region ${target.region}${target.gateway ? ` with egress gateway ${target.gateway}` : ''}`);
    let sandboxName = name;
    try {
      const sandbox = await this.request<BlaxelSandbox>(workspace, apiKey, 'POST', '/sandboxes', {
        metadata: {
          name,
          displayName: `Nodenesia proxy node ${input.nodeId}`,
          labels: {
            managedBy: 'proxy-node', nodeId: String(input.nodeId), orderId: String(input.orderId),
            blaxelRegion: target.region, ...(target.gateway ? { blaxelEgressGateway: target.gateway } : {}), ...input.metadata,
          },
        },
        spec: {
          enabled: true,
          region: target.region,
          ...(target.gateway ? { network: { egress: { mode: 'dedicated', gateway: target.gateway } } } : {}),
          runtime: {
            image,
            memory: this.memoryMb(),
            ttl: `${Math.max(1, Math.ceil(input.timeoutMs / 60_000))}m`,
          },
        },
      });
      sandboxName = sandbox.metadata?.name || name;
      const ready = await this.waitForDeployment(sandboxName, workspace, apiKey);
      const sandboxUrl = ready.metadata?.url;
      if (!sandboxUrl) throw new Error(`Blaxel sandbox ${sandboxName} did not return its sandbox API URL`);
      await this.exec(
        sandboxUrl,
        apiKey,
        'check-rendezvous',
        'timeout 5 bash -c \'exec 3<>/dev/tcp/"$TEST_HOST"/"$TEST_PORT"\' && echo "CONNECTED $TEST_HOST:$TEST_PORT" || { status=$?; echo "TCP_CHECK_FAILED status=$status $TEST_HOST:$TEST_PORT"; exit $status; }',
        { TEST_HOST: input.gost.masterHost, TEST_PORT: String(input.gost.rendezvousPort) },
        true,
        10,
      );
      const install = `if ! command -v curl >/dev/null 2>&1; then (apk add --no-cache curl || (apt-get update && apt-get install -y curl)); fi; ${this.gost.install(input.gost.version)}`;
      await this.exec(sandboxUrl, apiKey, 'install-gost', install, {}, true, 60);
      const local = this.gost.localSocks(input);
      await this.exec(sandboxUrl, apiKey, 'gost-socks', local.command, local.envs, false);
      await this.exec(sandboxUrl, apiKey, 'probe-local-socks', this.gost.probeLocal(input.gost.localPort), {}, true, 30);
      const tunnel = this.gost.reverseTunnel(input);
      await this.exec(sandboxUrl, apiKey, 'gost-tunnel', tunnel.command, tunnel.envs, false);
      return { ...this.mapInstance(ready), metadata: { ...(ready.metadata?.labels || {}), blaxelRegion: target.region, ...(target.gateway ? { blaxelEgressGateway: target.gateway } : {}) } };
    } catch (error) {
      await this.terminateInstance(sandboxName, input.providerApiKey).catch(() => undefined);
      await this.releaseNodeResources(input.nodeId).catch(() => undefined);
      throw error;
    }
  }

  async activateNodeResources(nodeId: number) {
    const result = await this.db.client.rpc('activate_blaxel_egress_gateway_lease', { target_node_id: nodeId });
    this.db.unwrap(result, 'Unable to activate Blaxel egress gateway lease');
  }

  async releaseNodeResources(nodeId: number) {
    const result = await this.db.client.rpc('release_blaxel_egress_gateway_lease', { target_node_id: nodeId });
    this.db.unwrap(result, 'Unable to release Blaxel egress gateway lease');
  }

  async getInstance(externalInstanceId: string, providerApiKey: string) {
    const { workspace, apiKey } = this.parseKey(providerApiKey);
    return this.mapInstance(await this.request<BlaxelSandbox>(workspace, apiKey, 'GET', `/sandboxes/${encodeURIComponent(externalInstanceId)}`));
  }

  async terminateInstance(externalInstanceId: string, providerApiKey: string) {
    const { workspace, apiKey } = this.parseKey(providerApiKey);
    await this.request(workspace, apiKey, 'DELETE', `/sandboxes/${encodeURIComponent(externalInstanceId)}`);
  }

  async listOwnedInstances(providerApiKey: string) {
    const { workspace, apiKey } = this.parseKey(providerApiKey);
    const result = await this.request<BlaxelSandbox[] | { data?: BlaxelSandbox[] }>(workspace, apiKey, 'GET', '/sandboxes?limit=200');
    const sandboxes = Array.isArray(result) ? result : result.data || [];
    return sandboxes.filter(sandbox => sandbox.metadata?.labels?.managedBy === 'proxy-node').map(sandbox => this.mapInstance(sandbox));
  }

  private async waitForDeployment(name: string, workspace: string, apiKey: string) {
    const deadline = Date.now() + Math.max(30_000, Number(this.config.get('BLAXEL_READY_TIMEOUT_MS') || 180_000));
    while (Date.now() < deadline) {
      const sandbox = await this.request<BlaxelSandbox>(workspace, apiKey, 'GET', `/sandboxes/${encodeURIComponent(name)}`);
      if (sandbox.status === 'DEPLOYED' && sandbox.metadata?.url) return sandbox;
      if (['FAILED', 'TERMINATED', 'DEACTIVATED', 'DELETING'].includes(String(sandbox.status))) throw new Error(`Blaxel sandbox ${name} entered ${sandbox.status}`);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error(`Blaxel sandbox ${name} did not deploy in time`);
  }

  private async exec(sandboxUrl: string, apiKey: string, name: string, command: string, env: Record<string, string>, waitForCompletion: boolean, timeout = 0) {
    const url = new URL(sandboxUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.bl.run')) throw new Error('Blaxel returned an invalid sandbox API URL');
    const response = await fetch(`${url.origin}/process`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        command,
        env,
        waitForCompletion,
        timeout,
        keepAlive: !waitForCompletion,
        restartOnFailure: !waitForCompletion,
        maxRestarts: waitForCompletion ? 0 : 1000,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Blaxel sandbox process ${name} failed (${response.status}): ${detail || response.statusText}`);
    }
    if (waitForCompletion) {
      const result = await response.json() as { exitCode?: number; logs?: string; stdout?: string; stderr?: string };
      const output = [result.logs, result.stderr, result.stdout].filter(Boolean).join('\n').slice(-1000);
      if (result.exitCode !== undefined && result.exitCode !== 0) throw new Error(`Blaxel sandbox process ${name} exited with ${result.exitCode}: ${output || 'no process output returned'}`);
    }
  }

  private async request<T = unknown>(workspace: string, apiKey: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const baseUrl = String(this.config.get('BLAXEL_API_BASE_URL') || 'https://api.blaxel.ai/v0').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'X-Blaxel-Authorization': `Bearer ${apiKey}`,
        'X-Blaxel-Workspace': workspace,
        'Blaxel-Version': String(this.config.get('BLAXEL_API_VERSION') || '2026-04-16'),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Blaxel API ${method} ${path} failed (${response.status}): ${detail || response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private parseKey(value: string) {
    const separator = value.indexOf('|');
    const workspace = value.slice(0, separator).trim();
    const apiKey = value.slice(separator + 1).trim();
    if (separator < 1 || separator !== value.lastIndexOf('|') || !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(workspace) || apiKey.length < 8) {
      throw new Error('Blaxel provider API key must use BLAXEL_WORKSPACE|BLAXEL_API_KEY');
    }
    return { workspace, apiKey };
  }

  private memoryMb() {
    const configured = Number(this.config.get('BLAXEL_SANDBOX_MEMORY_MB') || 1024);
    return Math.max(512, Math.min(65536, Number.isFinite(configured) ? Math.floor(configured) : 1024));
  }

  private async selectTarget(nodeId: number, apiKeyId: number) {
    const result = await this.db.client.rpc('reserve_blaxel_egress_gateway', {
      target_node_id: nodeId,
      target_provider_api_key_id: apiKeyId,
      lease_seconds: 900,
    });
    const rows = this.db.unwrap(result, 'Unable to reserve a Blaxel egress gateway') as Array<{ selected_region: string; selected_gateway: string }>;
    const target = rows[0];
    if (!target) throw new Error('No dedicated Blaxel egress IP is available');
    return { region: target.selected_region, gateway: target.selected_gateway };
  }

  private mapInstance(sandbox: BlaxelSandbox): ProviderInstance {
    const lifecycleStatus = String(sandbox.status || '');
    const status: ProviderInstance['status'] = lifecycleStatus === 'DEPLOYED'
      ? 'running'
      : ['UPLOADING', 'BUILDING', 'DEPLOYING', 'BUILT'].includes(lifecycleStatus)
        ? 'provisioning'
        : lifecycleStatus === 'FAILED' ? 'error' : 'stopped';
    const expiresAt = Number.isFinite(sandbox.expiresIn) ? new Date(Date.now() + Number(sandbox.expiresIn) * 1000) : undefined;
    return { externalInstanceId: sandbox.metadata?.name || '', status, startedAt: sandbox.metadata?.createdAt ? new Date(sandbox.metadata.createdAt) : undefined, expiresAt, metadata: sandbox.metadata?.labels };
  }
}
