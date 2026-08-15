import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GostCommandBuilder } from '../gost/gost-command.builder';
import type { ComputeProvider, ProviderInstance, ProvisionNodeInput } from './compute-provider';

type RunloopDevbox = { id: string; status: string; create_time_ms?: number; end_time_ms?: number | null; metadata?: Record<string, string> };

@Injectable()
export class RunloopProvider implements ComputeProvider {
  readonly type = 'runloop';
  readonly capabilities = { executionMode: 'sandbox' as const, supportsInteractiveExec: true, supportsLongRunning: true, supportsOutboundTcp: true, supportsLifetimeExtension: false, supportsCustomImage: true, maxRuntimeSeconds: 3600 };

  constructor(private readonly gost: GostCommandBuilder, private readonly config: ConfigService) {}

  async provisionNode(input: ProvisionNodeInput): Promise<ProviderInstance> {
    const local = this.gost.localSocks(input);
    const tunnel = this.gost.reverseTunnel(input);
    const body: Record<string, unknown> = {
      name: `proxy-node-${input.nodeId}`,
      metadata: { ...input.metadata, managedBy: 'proxy-node', nodeId: String(input.nodeId), orderId: String(input.orderId) },
      launch_parameters: {
        // Fixed independently from E2B: X_SMALL and a hard one-hour lifetime.
        resource_size_request: 'X_SMALL',
        keep_alive_time_seconds: 3600,
        launch_commands: [this.gost.install(input.gost.version), this.background(local.command, local.envs), this.gost.probeLocal(input.gost.localPort), this.background(tunnel.command, tunnel.envs)],
      },
    };
    if (input.template) {
      if (/^bp_/.test(input.template)) body.blueprint_id = input.template;
      else body.blueprint_name = input.template;
    }
    const devbox = await this.request<RunloopDevbox>(input.providerApiKey, 'POST', '/v1/devboxes', body);
    try {
      return this.mapInstance(await this.waitForRunning(devbox.id, input.providerApiKey));
    } catch (error) {
      await this.terminateInstance(devbox.id, input.providerApiKey).catch(() => undefined);
      throw error;
    }
  }

  async getInstance(externalInstanceId: string, providerApiKey: string) {
    return this.mapInstance(await this.request<RunloopDevbox>(providerApiKey, 'GET', `/v1/devboxes/${encodeURIComponent(externalInstanceId)}`));
  }

  async terminateInstance(externalInstanceId: string, providerApiKey: string) {
    await this.request(providerApiKey, 'POST', `/v1/devboxes/${encodeURIComponent(externalInstanceId)}/shutdown?force=true`);
  }

  async listOwnedInstances(providerApiKey: string) {
    const result = await this.request<{ devboxes?: RunloopDevbox[] }>(providerApiKey, 'GET', '/v1/devboxes?limit=100');
    return (result.devboxes || []).filter(devbox => devbox.metadata?.managedBy === 'proxy-node').map(devbox => this.mapInstance(devbox));
  }

  private async waitForRunning(id: string, apiKey: string) {
    const deadline = Date.now() + Math.max(30_000, Number(this.config.get('RUNLOOP_READY_TIMEOUT_MS') || 120_000));
    while (Date.now() < deadline) {
      const devbox = await this.request<RunloopDevbox>(apiKey, 'GET', `/v1/devboxes/${encodeURIComponent(id)}`);
      if (devbox.status === 'running') return devbox;
      if (['failure', 'shutdown'].includes(devbox.status)) throw new Error(`Runloop Devbox ${id} entered ${devbox.status}`);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error(`Runloop Devbox ${id} did not become ready in time`);
  }

  private async request<T = unknown>(apiKey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const baseUrl = String(this.config.get('RUNLOOP_API_BASE_URL') || 'https://api.runloop.ai').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Runloop API ${method} ${path} failed (${response.status}): ${detail || response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private mapInstance(devbox: RunloopDevbox): ProviderInstance {
    const status: ProviderInstance['status'] = devbox.status === 'running' ? 'running' : ['scheduled', 'provisioning', 'initializing', 'resuming'].includes(devbox.status) ? 'provisioning' : devbox.status === 'failure' ? 'error' : 'stopped';
    return { externalInstanceId: devbox.id, status, startedAt: devbox.create_time_ms ? new Date(devbox.create_time_ms) : undefined, expiresAt: devbox.end_time_ms ? new Date(devbox.end_time_ms) : undefined, metadata: devbox.metadata };
  }

  private background(command: string, envs: Record<string, string>) {
    const environment = Object.entries(envs).map(([key, value]) => `${key}=${this.shellQuote(value)}`).join(' ');
    return `${environment} nohup sh -c ${this.shellQuote(command)} >/dev/null 2>&1 &`;
  }

  private shellQuote(value: string) { return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`; }
}
