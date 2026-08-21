import { Injectable } from '@nestjs/common';
import { GithubActionsControlPlaneService } from './github-actions-control-plane.service';
import { ProviderAccountDisabledError, type ComputeProvider, type ProviderInstance, type ProvisionNodeInput } from './compute-provider';

const BANNED_MESSAGE_PATTERN = /banned|suspended|blocked|account.*(disabled|deactivated)/i;

@Injectable()
export class GithubActionsProvider implements ComputeProvider {
  readonly type = 'github';
  readonly capabilities = { executionMode: 'job' as const, supportsInteractiveExec: false, supportsLongRunning: false, supportsOutboundTcp: true, supportsLifetimeExtension: false, supportsCustomImage: false, maxRuntimeSeconds: 3600 };

  constructor(private readonly controlPlane: GithubActionsControlPlaneService) {}

  async provisionNode(input: ProvisionNodeInput): Promise<ProviderInstance> {
    const { owner, apiKey } = this.parseKey(input.providerApiKey);
    const repository = await this.controlPlane.repositoryForKey(input.providerApiKeyId);
    // Repositories created before HTTP support contain a SOCKS-only workflow.
    // Upgrade that controlled workflow before dispatch so existing API keys do
    // not provision a node that cannot pass the HTTP readiness check.
    await this.ensureHttpProxyWorkflow(owner, repository, apiKey);
    const taskId = await this.controlPlane.createTask(input, owner, repository);
    try {
      await this.request(apiKey, 'POST', `/repos/${owner}/${repository}/actions/workflows/gost-sandbox.yml/dispatches`, {
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
    if (!response.ok) {
      const detail = await response.json().catch(() => undefined) as { message?: string } | undefined;
      const detailMessage = detail?.message || '';
      if (response.status === 401 || response.status === 403 || BANNED_MESSAGE_PATTERN.test(detailMessage)) {
        throw new ProviderAccountDisabledError(detailMessage || 'GitHub API key cannot dispatch or cancel this workflow');
      }
      throw new Error(`GitHub Actions API request failed (${response.status})`);
    }
  }

  private async ensureHttpProxyWorkflow(owner: string, repository: string, apiKey: string) {
    const path = `/repos/${owner}/${repository}/contents/.github/workflows/gost-sandbox.yml`;
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${apiKey}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) await this.throwGithubError(response, 'GitHub workflow could not be read');
    const file = await response.json() as { content?: string; sha?: string };
    if (!file.content || !file.sha) throw new Error('GitHub GOST workflow is missing its file content');
    const workflow = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (workflow.includes('/tmp/gost -L="auto://')) return;
    const updated = workflow.replace('/tmp/gost -L="socks5://', '/tmp/gost -L="auto://');
    if (updated === workflow) throw new Error('GitHub GOST workflow does not contain the managed proxy listener');
    const update = await fetch(`https://api.github.com${path}`, {
      method: 'PUT',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${apiKey}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Enable HTTP and SOCKS5 proxy listener', content: Buffer.from(updated).toString('base64'), sha: file.sha }),
    });
    if (!update.ok) await this.throwGithubError(update, 'GitHub workflow could not be upgraded');
  }

  private async throwGithubError(response: Response, fallback: string): Promise<never> {
    const detail = await response.json().catch(() => undefined) as { message?: string } | undefined;
    const message = detail?.message || fallback;
    if (response.status === 401 || response.status === 403 || BANNED_MESSAGE_PATTERN.test(message)) {
      throw new ProviderAccountDisabledError(message);
    }
    throw new Error(`${fallback} (${response.status})`);
  }

}
