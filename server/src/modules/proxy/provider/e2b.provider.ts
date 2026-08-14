import { Injectable } from '@nestjs/common';
import { Sandbox } from 'e2b';
import { GostCommandBuilder } from '../gost/gost-command.builder';
import type { ComputeProvider, ProviderInstance, ProvisionNodeInput } from './compute-provider';

@Injectable()
export class E2bProvider implements ComputeProvider {
  readonly type = 'e2b';
  readonly capabilities = {
    executionMode: 'sandbox' as const,
    supportsInteractiveExec: true,
    supportsLongRunning: true,
    supportsOutboundTcp: true,
    supportsLifetimeExtension: true,
    supportsCustomImage: true,
    maxRuntimeSeconds: 86400,
  };

  constructor(private readonly gost: GostCommandBuilder) {}

  async provisionNode(input: ProvisionNodeInput): Promise<ProviderInstance> {
    const options = {
      timeoutMs: input.timeoutMs,
      apiKey: input.providerApiKey,
      allowInternetAccess: true,
      secure: false,
      metadata: { ...input.metadata, managedBy: 'proxy-node', nodeId: String(input.nodeId), orderId: String(input.orderId) },
    };
    const sandbox = input.template ? await Sandbox.create(input.template, options) : await Sandbox.create(options);
    try {
      await sandbox.commands.run(this.gost.install(input.gost.version), { timeoutMs: 30000 });
      const local = this.gost.localSocks(input);
      await sandbox.commands.run(local.command, { background: true, envs: local.envs, timeoutMs: 0 });
      await sandbox.commands.run(this.gost.probeLocal(input.gost.localPort), { timeoutMs: 20000 });
      const tunnel = this.gost.reverseTunnel(input);
      await sandbox.commands.run(tunnel.command, { background: true, envs: tunnel.envs, timeoutMs: 0 });
      const ipResult = await sandbox.commands.run('curl -fsS --max-time 5 https://api.ipify.org || true', { timeoutMs: 8000 });
      return {
        externalInstanceId: sandbox.sandboxId,
        status: 'running',
        expiresAt: input.expiresAt,
        egressIp: ipResult.stdout.trim() || null,
      };
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  }

  async getInstance(externalInstanceId: string, providerApiKey: string): Promise<ProviderInstance> {
    const info = await Sandbox.getInfo(externalInstanceId, { apiKey: providerApiKey });
    return { externalInstanceId, status: info.state === 'running' ? 'running' : 'stopped', startedAt: info.startedAt, expiresAt: info.endAt, metadata: info.metadata };
  }

  async terminateInstance(externalInstanceId: string, providerApiKey: string) {
    await Sandbox.kill(externalInstanceId, { apiKey: providerApiKey });
  }

  async listOwnedInstances(providerApiKey: string): Promise<ProviderInstance[]> {
    const paginator = Sandbox.list({ apiKey: providerApiKey, query: { metadata: { managedBy: 'proxy-node' } }, limit: 100 });
    const instances: ProviderInstance[] = [];
    while (paginator.hasNext) {
      const page = await paginator.nextItems();
      instances.push(...page.map(info => ({
        externalInstanceId: info.sandboxId,
        status: info.state === 'running' ? 'running' as const : 'stopped' as const,
        startedAt: info.startedAt,
        expiresAt: info.endAt,
        metadata: info.metadata,
      })));
    }
    return instances;
  }
}
