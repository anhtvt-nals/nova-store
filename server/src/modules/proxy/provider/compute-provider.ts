export type ProviderExecutionMode = 'sandbox' | 'job' | 'container';

/**
 * Thrown by a ComputeProvider when the provider account/API key itself is
 * unusable (banned, suspended, revoked, or otherwise unauthorized) rather
 * than a transient provisioning failure. The provisioning processor reacts
 * to this by marking the provider API key as revoked and retrying quickly
 * with the next active key for the same provider.
 */
export class ProviderAccountDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAccountDisabledError';
  }
}

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
  providerApiKeyId: number;
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
    wsPath?: string;
    tlsSecure?: boolean;
    tlsServerName?: string;
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
  /** Finalize or release provider-specific resources associated with a node. */
  activateNodeResources?(nodeId: number): Promise<void>;
  releaseNodeResources?(nodeId: number): Promise<void>;
  renewInstance?(externalInstanceId: string, expiresAt: Date): Promise<void>;
  listOwnedInstances(providerApiKey: string): Promise<ProviderInstance[]>;
}
