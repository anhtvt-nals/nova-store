import { Injectable } from '@nestjs/common';
import { GithubActionsControlPlaneService } from './github-actions-control-plane.service';
import type { ComputeProvider, ProviderInstance, ProvisionNodeInput } from './compute-provider';

@Injectable()
export class GithubActionsProvider implements ComputeProvider {
  readonly type = 'github';
  readonly capabilities = { executionMode: 'job' as const, supportsInteractiveExec: false, supportsLongRunning: false, supportsOutboundTcp: true, supportsLifetimeExtension: false, supportsCustomImage: false, maxRuntimeSeconds: 3600 };

  constructor(private readonly controlPlane: GithubActionsControlPlaneService) {}

  async provisionNode(input: ProvisionNodeInput): Promise<ProviderInstance> {
    const { owner, apiKey } = this.parseKey(input.providerApiKey);
    const taskId = await this.controlPlane.createTask(input, owner);
    try {
      await this.request(apiKey, 'POST', `/repos/${owner}/nodenesia-gost-sandbox/actions/workflows/gost-sandbox.yml/dispatches`, {
        ref: 'main', inputs: { task_id: taskId },
      });
      return { externalInstanceId: taskId, status: 'provisioning', startedAt: new Date(), expiresAt: input.expiresAt };
    } catch (error) {
      await this.controlPlane.cancel(taskId).catch(() => undefined);
      throw error;
    }
  }

  async getInstance(externalInstanceId: string, _providerApiKey: string) { return this.controlPlane.instance(externalInstanceId); }

  async terminateInstance(externalInstanceId: string, providerApiKey: string) {
    const { apiKey } = this.parseKey(providerApiKey);
    const task = await this.controlPlane.cancel(externalInstanceId);
    if (task?.workflow_run_id) await this.request(apiKey, 'POST', `/repos/${task.github_owner}/${task.repository}/actions/runs/${task.workflow_run_id}/cancel`);
  }

  async listOwnedInstances(providerApiKey: string) { return this.controlPlane.ownedInstances(this.parseKey(providerApiKey).owner); }

  private parseKey(value: string) {
    const separator = value.indexOf('|');
    const owner = value.slice(0, separator).trim();
    const apiKey = value.slice(separator + 1).trim();
    if (separator < 1 || separator !== value.lastIndexOf('|') || !/^[A-Za-z0-9-]+$/.test(owner) || apiKey.length < 8) throw new Error('GitHub provider API key must use GITHUB_OWNER|GITHUB_API_KEY');
    return { owner, apiKey };
  }

  private async request(apiKey: string, method: 'POST', path: string, body?: Record<string, unknown>) {
    const response = await fetch(`https://api.github.com${path}`, { method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${apiKey}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'GitHub API key cannot dispatch or cancel this workflow' : `GitHub Actions API request failed (${response.status})`);
  }
}
