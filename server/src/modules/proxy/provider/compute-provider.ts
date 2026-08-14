export type ProviderExecutionMode = 'sandbox' | 'job' | 'container';

export interface ProviderCapabilities {
  executionMode: ProviderExecutionMode;
  supportsInteractiveExec: boolean;
  supportsLongRunning: boolean;
  supportsOutboundTcp: boolean;
  supportsLifetimeExtension: boolean;
  supportsCustomImage: boolean;
  maxRuntimeSeconds: number | null;
}

export interface ProvisionNodeInput {
  nodeId: number;
  orderId: number;
  providerApiKey: string;
  template?: string;
  timeoutMs: number;
  expiresAt: Date;
  metadata: Record<string, string>;
  gost: {
    version: string;
    localPort: number;
    publicHost: string;
    bindPort: number;
    masterHost: string;
    rendezvousPort: number;
    tunnelTransport: 'tcp' | 'ws' | 'wss';
    tunnelUsername: string;
    tunnelPassword: string;
    socksUsername: string;
    socksPassword: string;
    bandwidthIn: string | null;
    bandwidthOut: string | null;
    maxConnections: number | null;
  };
}

export interface ProviderInstance {
  externalInstanceId: string;
  status: 'provisioning' | 'running' | 'stopping' | 'stopped' | 'error';
  expiresAt?: Date;
  startedAt?: Date;
  egressIp?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ComputeProvider {
  readonly type: string;
  readonly capabilities: ProviderCapabilities;
  provisionNode(input: ProvisionNodeInput): Promise<ProviderInstance>;
  getInstance(externalInstanceId: string, providerApiKey: string): Promise<ProviderInstance>;
  terminateInstance(externalInstanceId: string, providerApiKey: string): Promise<void>;
  renewInstance?(externalInstanceId: string, expiresAt: Date): Promise<void>;
  listOwnedInstances(providerApiKey: string): Promise<ProviderInstance[]>;
}
