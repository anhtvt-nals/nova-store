export const PROXY_NODE_STATUSES = [
  'queued', 'provisioning', 'online', 'rotating', 'degraded', 'offline',
  'error', 'expired', 'terminating', 'terminated',
] as const;

export type ProxyNodeStatus = (typeof PROXY_NODE_STATUSES)[number];

export interface ProxyNodeEventPayload {
  nodeId?: number;
  status?: ProxyNodeStatus;
  [key: string]: unknown;
}

