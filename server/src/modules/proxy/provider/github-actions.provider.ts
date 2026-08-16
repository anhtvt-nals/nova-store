import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GithubActionsControlPlaneService } from './github-actions-control-plane.service';
import type { ComputeProvider, ProviderInstance, ProvisionNodeInput } from './compute-provider';

@Injectable()
export class GithubActionsProvider implements ComputeProvider {
  readonly type = 'github';
  readonly capabilities = { executionMode: 'job' as const, supportsInteractiveExec: false, supportsLongRunning: false, supportsOutboundTcp: true, supportsLifetimeExtension: false, supportsCustomImage: false, maxRuntimeSeconds: 3600 };

  constructor(private readonly controlPlane: GithubActionsControlPlaneService, private readonly config: ConfigService) {}

  async provisionNode(input: ProvisionNodeInput): Promise<ProviderInstance> {
    const { owner, apiKey } = this.parseKey(input.providerApiKey);
    await this.ensureSandboxRepository(owner, apiKey);
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

  /** Idempotent bootstrap: the first node for an API key creates its public
   * runner repo; every later node only dispatches the existing workflow. */
  private async ensureSandboxRepository(owner: string, apiKey: string) {
    const templateOwner = String(this.config.get('GITHUB_TEMPLATE_OWNER') || '').trim();
    const controlPlaneUrl = this.controlPlane.controlPlaneUrl();
    if (!/^[A-Za-z0-9-]+$/.test(templateOwner)) throw new Error('GITHUB_TEMPLATE_OWNER must be configured for GitHub provisioning');
    const repository = 'nodenesia-gost-sandbox';
    const existing = await this.githubRequest(`/repos/${owner}/${repository}`, apiKey, 'GET', [200, 404]);
    if (existing.status === 404) {
      try {
        await this.githubRequest(`/repos/${templateOwner}/nodenesia-gost-template/generate`, apiKey, 'POST', [201], {
          owner, name: repository, description: 'Public short-lived GOST v3 runner for Nodenesia', private: false, include_all_branches: false,
        });
      } catch (error) {
        // A concurrent node may have created it after our initial GET.
        const appeared = await this.githubRequest(`/repos/${owner}/${repository}`, apiKey, 'GET', [200, 404]);
        if (appeared.status === 404) throw error;
      }
    }
    const variablePath = `/repos/${owner}/${repository}/actions/variables/NODENESIA_CONTROL_PLANE_URL`;
    const updated = await this.githubRequest(variablePath, apiKey, 'PATCH', [204, 404], { name: 'NODENESIA_CONTROL_PLANE_URL', value: controlPlaneUrl });
    if (updated.status === 404) await this.githubRequest(`/repos/${owner}/${repository}/actions/variables`, apiKey, 'POST', [201], { name: 'NODENESIA_CONTROL_PLANE_URL', value: controlPlaneUrl });
  }

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

  private async githubRequest(path: string, apiKey: string, method: 'GET' | 'POST' | 'PATCH', expected: number[], body?: Record<string, unknown>) {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${apiKey}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (expected.includes(response.status)) return { status: response.status };
    if (response.status === 401 || response.status === 403) throw new Error('GitHub API key lacks repository, Actions variables, or workflow-dispatch access');
    throw new Error(`GitHub repository bootstrap failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
}
