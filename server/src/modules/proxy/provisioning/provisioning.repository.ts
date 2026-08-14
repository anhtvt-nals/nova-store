import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface ProvisioningJob {
  id: number;
  node_id: number;
  action: 'provision' | 'replace' | 'terminate';
  attempts: number;
  max_attempts: number;
}

@Injectable()
export class ProvisioningRepository {
  constructor(private readonly db: DatabaseService) {}

  async claim(workerId: string, lockSeconds: number): Promise<ProvisioningJob | null> {
    const result = await this.db.client.rpc('claim_proxy_provisioning_job', { worker_id: workerId, lock_seconds: lockSeconds });
    const rows = this.db.unwrap(result, 'Unable to claim proxy provisioning job') as ProvisioningJob[];
    return rows[0] || null;
  }

  async renewLease(jobId: number, workerId: string, lockSeconds: number) {
    const result = await this.db.client.rpc('renew_proxy_provisioning_lease', {
      target_job_id: jobId,
      worker_id: workerId,
      lock_seconds: lockSeconds,
    });
    return Boolean(this.db.unwrap(result, 'Unable to renew proxy provisioning lease'));
  }

  async enqueueDueRotations(batchSize: number) {
    const result = await this.db.client.rpc('enqueue_due_proxy_rotations', { batch_size: batchSize });
    const rows = this.db.unwrap(result, 'Unable to schedule due proxy rotations') as Array<{
      scheduled_job_id: number;
      scheduled_node_id: number;
    }>;
    return rows.map(row => ({ jobId: Number(row.scheduled_job_id), nodeId: Number(row.scheduled_node_id) }));
  }

  async enqueueExpiredTerminations(batchSize: number) {
    const result = await this.db.client.rpc('enqueue_expired_proxy_terminations', { batch_size: batchSize });
    const rows = this.db.unwrap(result, 'Unable to schedule expired order cleanups') as Array<{
      scheduled_job_id: number;
      scheduled_node_id: number;
    }>;
    return rows.map(row => ({ jobId: Number(row.scheduled_job_id), nodeId: Number(row.scheduled_node_id) }));
  }

  async context(nodeId: number, action: ProvisioningJob['action']) {
    const result = await this.db.client.from('proxy_nodes')
      .select('id,order_id,profile_id,provider_id,provider_api_key_id,current_instance_id,public_host,tunnel_port,metadata,orders(id,rental_days,status,expires_at)')
      .eq('id', nodeId).maybeSingle();
    const row = this.db.unwrap(result, 'Unable to load proxy provisioning context') as any;
    if (!row) throw new Error('Proxy node not found');
    const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    const validProvision = action === 'provision' && order?.status === 'provisioning';
    const validReplacement = action === 'replace' && order?.status === 'active'
      && order.expires_at && new Date(order.expires_at) > new Date();
    if (!validProvision && !validReplacement) throw new Error(action === 'replace' ? 'Order is not active' : 'Order is not awaiting provisioning');
    return {
      nodeId: row.id as number,
      orderId: row.order_id as number,
      profileId: row.profile_id as number,
      providerId: row.provider_id as number | null,
      providerApiKeyId: row.provider_api_key_id as number | null,
      currentInstanceId: row.current_instance_id as string | null,
      publicHost: row.public_host as string | null,
      tunnelPort: row.tunnel_port as number | null,
      rentalDays: Number(order.rental_days),
      orderExpiresAt: order.expires_at as string | null,
      metadata: (row.metadata || {}) as Record<string, unknown>,
    };
  }

  async terminationContext(nodeId: number) {
    const result = await this.db.client.from('proxy_nodes')
      .select('id,provider_id,provider_api_key_id,current_instance_id,orders(status)')
      .eq('id', nodeId).maybeSingle();
    const row = this.db.unwrap(result, 'Unable to load proxy termination context') as any;
    if (!row) throw new Error('Proxy node not found');
    const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    if (order?.status !== 'expired') throw new Error('Order is not expired');
    return {
      nodeId: row.id as number,
      providerId: row.provider_id as number | null,
      providerApiKeyId: row.provider_api_key_id as number | null,
      currentInstanceId: row.current_instance_id as string | null,
    };
  }

  async reserveCapacity(nodeId: number, workerId: string, purpose: 'customer' | 'replacement') {
    const result = await this.db.client.rpc('reserve_provider_capacity', {
      target_node_id: nodeId,
      worker_id: workerId,
      lease_seconds: 600,
      target_purpose: purpose,
    });
    const rows = this.db.unwrap(result, 'Unable to reserve provider capacity') as Array<{
      lease_id: string;
      selected_provider_id: number;
      selected_api_key_id: number;
      provider_code: string;
    }>;
    const lease = rows[0];
    if (!lease) throw new Error('No provider capacity or active provider API key is available');
    return {
      leaseId: lease.lease_id,
      providerId: lease.selected_provider_id,
      apiKeyId: lease.selected_api_key_id,
      providerCode: lease.provider_code,
    };
  }

  async allocateTunnelEndpoint(nodeId: number, workerId: string, publicHost: string, firstPort: number, lastPort: number) {
    const result = await this.db.client.rpc('allocate_proxy_tunnel_endpoint', {
      target_node_id: nodeId,
      worker_id: workerId,
      target_public_host: publicHost,
      first_port: firstPort,
      last_port: lastPort,
    });
    const rows = this.db.unwrap(result, 'Unable to allocate proxy tunnel endpoint') as Array<{
      assigned_host: string;
      assigned_port: number;
    }>;
    if (!rows[0]) throw new Error('No proxy tunnel endpoint was allocated');
    return { publicHost: rows[0].assigned_host, tunnelPort: Number(rows[0].assigned_port) };
  }

  async provider(providerId: number, apiKeyId: number) {
    const [providerResult, keyResult] = await Promise.all([
      this.db.client.from('proxy_providers').select('id,code,metadata').eq('id', providerId).single(),
      this.db.client.from('provider_api_keys').select('id,secret_ciphertext,secret_iv,secret_tag').eq('id', apiKeyId).eq('status', 'active').single(),
    ]);
    const provider = this.db.unwrap(providerResult, 'Unable to load compute provider');
    const key = this.db.unwrap(keyResult, 'Unable to load provider API key');
    return {
      driver: String(provider.metadata?.driver || provider.code),
      metadata: (provider.metadata || {}) as Record<string, unknown>,
      key,
    };
  }

  async providerForTermination(providerId: number, apiKeyId: number) {
    const [providerResult, keyResult] = await Promise.all([
      this.db.client.from('proxy_providers').select('id,code,metadata').eq('id', providerId).single(),
      this.db.client.from('provider_api_keys').select('id,secret_ciphertext,secret_iv,secret_tag').eq('id', apiKeyId).single(),
    ]);
    const provider = this.db.unwrap(providerResult, 'Unable to load existing compute provider');
    const key = this.db.unwrap(keyResult, 'Unable to load existing provider API key');
    return { driver: String(provider.metadata?.driver || provider.code), key };
  }

  async clearReplacedInstance(nodeId: number, externalInstanceId: string) {
    const nodeResult = await this.db.client.from('proxy_nodes').update({ current_instance_id: null })
      .eq('id', nodeId).eq('current_instance_id', externalInstanceId);
    if (nodeResult.error) throw nodeResult.error;
  }

  async releaseCustomerCapacity(nodeId: number) {
    const leaseResult = await this.db.client.from('provider_capacity_leases')
      .update({ status: 'released', released_at: new Date().toISOString() })
      .eq('node_id', nodeId).eq('purpose', 'customer').is('released_at', null);
    if (leaseResult.error) throw leaseResult.error;
  }

  async assignProvider(nodeId: number, providerId: number, apiKeyId: number) {
    const result = await this.db.client.from('proxy_nodes').update({ provider_id: providerId, provider_api_key_id: apiKeyId }).eq('id', nodeId);
    if (result.error) throw result.error;
  }

  async recordInstance(input: { nodeId: number; providerId: number; apiKeyId: number; externalInstanceId: string; expiresAt: Date }) {
    const result = await this.db.client.from('proxy_node_instances').insert({
      node_id: input.nodeId,
      provider_id: input.providerId,
      provider_api_key_id: input.apiKeyId,
      external_instance_id: input.externalInstanceId,
      status: 'running',
      started_at: new Date().toISOString(),
      expires_at: input.expiresAt.toISOString(),
      last_heartbeat_at: new Date().toISOString(),
    });
    if (result.error) throw result.error;
  }

  async markInstanceStopped(providerId: number, externalInstanceId: string, status: 'stopped' | 'error') {
    const result = await this.db.client.from('proxy_node_instances').update({
      status,
      stopped_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
    }).eq('provider_id', providerId).eq('external_instance_id', externalInstanceId);
    if (result.error) throw result.error;
  }

  async reconciliationTargets() {
    const result = await this.db.client.from('provider_api_keys')
      .select('id,provider_id,secret_ciphertext,secret_iv,secret_tag,proxy_providers(code,metadata)')
      .eq('status', 'active');
    return this.db.unwrap(result, 'Unable to load provider reconciliation targets') as any[];
  }

  async trackedInstances(providerId: number, apiKeyId: number) {
    const result = await this.db.client.from('proxy_node_instances')
      .select('external_instance_id,status')
      .eq('provider_id', providerId)
      .eq('provider_api_key_id', apiKeyId)
      .in('status', ['provisioning', 'running']);
    return this.db.unwrap(result, 'Unable to load tracked provider instances') as Array<{ external_instance_id: string; status: string }>;
  }

  async complete(input: { jobId: number; workerId: string; externalInstanceId: string; egressIp: string | null; publicHost: string; tunnelPort: number; nextRotationAt: Date }) {
    const result = await this.db.client.rpc('complete_proxy_provisioning', {
      target_job_id: input.jobId,
      worker_id: input.workerId,
      external_instance_id: input.externalInstanceId,
      reported_egress_ip: input.egressIp || null,
      reported_public_host: input.publicHost,
      reported_tunnel_port: input.tunnelPort,
      reported_next_rotation_at: input.nextRotationAt.toISOString(),
    });
    this.db.unwrap(result, 'Unable to complete proxy provisioning');
  }

  async completeReplacement(input: { jobId: number; workerId: string; externalInstanceId: string; egressIp: string | null; nextRotationAt: Date }) {
    const result = await this.db.client.rpc('complete_proxy_replacement', {
      target_job_id: input.jobId,
      worker_id: input.workerId,
      external_instance_id: input.externalInstanceId,
      reported_egress_ip: input.egressIp || null,
      reported_next_rotation_at: input.nextRotationAt.toISOString(),
    });
    this.db.unwrap(result, 'Unable to complete proxy replacement');
  }

  async completeTermination(jobId: number, workerId: string) {
    const result = await this.db.client.rpc('complete_proxy_termination', {
      target_job_id: jobId,
      worker_id: workerId,
    });
    this.db.unwrap(result, 'Unable to complete proxy termination');
  }

  async fail(jobId: number, workerId: string, message: string, delaySeconds: number) {
    const result = await this.db.client.rpc('fail_proxy_provisioning', {
      target_job_id: jobId,
      worker_id: workerId,
      failure_message: message,
      retry_delay_seconds: delaySeconds,
    });
    return this.db.unwrap(result, 'Unable to record proxy provisioning failure') as string;
  }

  async failReplacement(jobId: number, workerId: string, message: string, delaySeconds: number) {
    const result = await this.db.client.rpc('fail_proxy_replacement', {
      target_job_id: jobId,
      worker_id: workerId,
      failure_message: message,
      retry_delay_seconds: delaySeconds,
    });
    return this.db.unwrap(result, 'Unable to record proxy replacement failure') as string;
  }

  async failTermination(jobId: number, workerId: string, message: string, delaySeconds: number) {
    const result = await this.db.client.rpc('fail_proxy_termination', {
      target_job_id: jobId,
      worker_id: workerId,
      failure_message: message,
      retry_delay_seconds: delaySeconds,
    });
    return this.db.unwrap(result, 'Unable to record proxy termination failure') as string;
  }
}
