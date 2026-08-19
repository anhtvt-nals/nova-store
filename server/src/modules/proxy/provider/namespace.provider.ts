import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderAccountDisabledError, type ComputeProvider, type ProviderInstance, type ProvisionNodeInput } from './compute-provider';

const disabled = /permission.?denied|unauthenticated|invalid.*token|token.*expired|access denied/i;

@Injectable()
export class NamespaceProvider implements ComputeProvider {
  readonly type = 'namespace';
  readonly capabilities = { executionMode: 'container' as const, supportsInteractiveExec: false, supportsLongRunning: true, supportsOutboundTcp: true, supportsLifetimeExtension: false, supportsCustomImage: true, maxRuntimeSeconds: 86400 };
  constructor(private readonly config: ConfigService) {}

  // The Namespace SDK is ESM-only while this Nest build intentionally uses the
  // existing CommonJS resolver. Load it lazily so we do not alter resolution
  // behaviour for every existing provider.
  private async sdk() { return new Function('return Promise.all([import("@namespacelabs/cloud/node"), import("@namespacelabs/cloud")])')() as Promise<[any, any]>; }
  private regions() {
    const regions = String(this.config.get('NAMESPACE_REGION') || 'us').split('|').map(value => value.trim()).filter(value => /^[a-z][a-z0-9-]{1,62}$/.test(value));
    return [...new Set(regions)].length ? [...new Set(regions)] : ['us'];
  }
  private randomRegion() { const regions = this.regions(); return regions[Math.floor(Math.random() * regions.length)]; }
  private async clients(token: string, region = this.randomRegion()) { const [node] = await this.sdk(); return node.createClients(region, { token }); }
  private err(error: unknown) { const message = error instanceof Error ? error.message : String(error); return disabled.test(message) ? new ProviderAccountDisabledError(message) : new Error(message); }
  private placement(region: string) { return String(this.config.get('NAMESPACE_PLACEMENT') || `continent:${region}`).split('|').map(v => v.trim()).filter(Boolean); }
  private startup(input: ProvisionNodeInput) {
    const scheme = input.gost.tunnelTransport === 'tcp' ? 'socks5' : `socks5+${input.gost.tunnelTransport}`;
    const query = input.gost.tunnelTransport === 'tcp' ? '' : `?path=${encodeURIComponent(input.gost.wsPath || '/ws')}${input.gost.tunnelTransport === 'wss' ? `&secure=true&serverName=${encodeURIComponent(input.gost.tlsServerName || input.gost.masterHost)}` : ''}`;
    return `set -eu\n/bin/gost -L=\"socks5://${encodeURIComponent(input.gost.socksUsername)}:${encodeURIComponent(input.gost.socksPassword)}@127.0.0.1:${input.gost.localPort}\" >/tmp/socks.log 2>&1 &\nSOCKS_PID=$!\n/bin/gost -L=\"rtcp://:${input.gost.bindPort}/127.0.0.1:${input.gost.localPort}\" -F=\"${scheme}://${encodeURIComponent(input.gost.tunnelUsername)}:${encodeURIComponent(input.gost.tunnelPassword)}@${input.gost.masterHost}:${input.gost.rendezvousPort}${query}\" >/tmp/tunnel.log 2>&1 &\nTUNNEL_PID=$!\ntrap 'kill \"$SOCKS_PID\" \"$TUNNEL_PID\" 2>/dev/null || true' EXIT INT TERM\nwait \"$SOCKS_PID\" \"$TUNNEL_PID\"`;
  }
  async provisionNode(input: ProvisionNodeInput): Promise<ProviderInstance> {
    try {
      const region = this.randomRegion();
      const [clients, cloud] = await Promise.all([this.clients(input.providerApiKey, region), this.sdk()]);
      const created = await clients.compute.createInstance({
        placement: this.placement(region), shape: { virtualCpu: Number(this.config.get('NAMESPACE_VCPU') || 2), memoryMegabytes: Number(this.config.get('NAMESPACE_MEMORY_MB') || 2048), machineArch: 'amd64', os: 'linux' },
        documentedPurpose: 'Nodenesia residential SOCKS5 node', deadline: { seconds: BigInt(Math.floor(input.expiresAt.getTime() / 1000)), nanos: 0 },
        labels: [{ name: 'managed-by', value: 'nodenesia-proxy' }, { name: 'node-id', value: String(input.nodeId) }],
        containers: [{ name: 'nodenesia-gost', imageRef: input.template || String(this.config.get('NAMESPACE_IMAGE') || 'gogost/gost:3.2.6'), entrypoint: ['/bin/sh', '-lc'], args: [this.startup(input)], network: cloud[1].ContainerRequest_Network.BRIDGE, workloadType: cloud[1].ContainerRequest_WorkloadType.SERVICE }],
      });
      const id = String(created.metadata?.instanceId || ''); if (!id) throw new Error('Namespace did not return an instance ID');
      return { externalInstanceId: id, status: 'running', expiresAt: input.expiresAt };
    } catch (error) { throw this.err(error); }
  }
  async getInstance(externalInstanceId: string, providerApiKey: string): Promise<ProviderInstance> { let lastError: unknown; for (const region of this.regions()) try { const [clients, cloud] = await Promise.all([this.clients(providerApiKey, region), this.sdk()]); const row = await clients.compute.describeInstance({ instanceId: externalInstanceId }); const status = row.metadata?.status; return { externalInstanceId, status: status === cloud[1].InstanceMetadata_Status.RUNNING ? 'running' : status === cloud[1].InstanceMetadata_Status.ERROR ? 'error' : 'stopped' }; } catch (error) { lastError = error; } throw this.err(lastError); }
  async terminateInstance(externalInstanceId: string, providerApiKey: string) { let lastError: unknown; for (const region of this.regions()) try { const clients = await this.clients(providerApiKey, region); await clients.compute.destroyInstance({ instanceId: externalInstanceId, reason: 'Nodenesia lifecycle cleanup' }); return; } catch (error) { lastError = error; } throw this.err(lastError); }
  async listOwnedInstances(providerApiKey: string): Promise<ProviderInstance[]> { try { const [, cloud] = await this.sdk(); const results = await Promise.all(this.regions().map(async region => { const clients = await this.clients(providerApiKey, region); const response = await clients.compute.listInstances({ maxEntries: 100n }); return (response.instances || []).filter((row: any) => (row.labels || []).some((x: any) => x.name === 'managed-by' && x.value === 'nodenesia-proxy')).map((row: any) => ({ externalInstanceId: String(row.instanceId), status: row.status === cloud.InstanceMetadata_Status.RUNNING ? 'running' : 'stopped' })); })); return results.flat().filter((instance, index, all) => all.findIndex(candidate => candidate.externalInstanceId === instance.externalInstanceId) === index); } catch (error) { throw this.err(error); } }
}
