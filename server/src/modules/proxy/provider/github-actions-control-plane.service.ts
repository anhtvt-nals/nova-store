import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { ProxySecretService } from '../proxy-secret.service';
import type { ProvisionNodeInput, ProviderInstance } from './compute-provider';

type Claims = { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; repository?: string; event_name?: string; workflow_ref?: string };
type TaskRow = { id: string; github_owner: string; repository: string; workflow_run_id: number | null; state: string; expires_at: string; claimed_at: string | null; config_ciphertext: string; config_iv: string; config_tag: string; created_at: string };
type GithubJwk = JsonWebKey & { kid?: string };

@Injectable()
export class GithubActionsControlPlaneService {
  private jwks: { keys?: GithubJwk[] } | null = null;
  private jwksExpiresAt = 0;

  constructor(private readonly db: DatabaseService, private readonly secrets: ProxySecretService, private readonly config: ConfigService) {}

  async createTask(input: ProvisionNodeInput, owner: string) {
    const encrypted = this.secrets.encrypt(JSON.stringify({ gost: input.gost }), 'PROXY_SECRET_ENCRYPTION_KEY');
    const result = await this.db.client.from('github_runner_tasks').insert({
      node_id: input.nodeId,
      provider_api_key_id: input.providerApiKeyId,
      github_owner: owner,
      config_ciphertext: encrypted.ciphertext,
      config_iv: encrypted.iv,
      config_tag: encrypted.tag,
      expires_at: input.expiresAt.toISOString(),
    }).select('id').single();
    return this.db.unwrap(result, 'Unable to create GitHub runner task').id as string;
  }

  async claim(taskId: string, oidcToken: string, runId: number) {
    const claims = await this.verifyOidc(oidcToken);
    const currentResult = await this.db.client.from('github_runner_tasks').select('*').eq('id', taskId).maybeSingle();
    const task = this.db.unwrap(currentResult, 'Unable to load GitHub runner task') as TaskRow | null;
    if (!task || task.state !== 'pending' || new Date(task.expires_at) <= new Date()) throw new UnauthorizedException('GitHub runner task is unavailable');
    const repository = `${task.github_owner}/${task.repository}`;
    if (claims.repository !== repository || claims.event_name !== 'workflow_dispatch' || !claims.workflow_ref?.startsWith(`${repository}/.github/workflows/gost-sandbox.yml@`)) {
      throw new UnauthorizedException('GitHub OIDC identity is not authorized for this task');
    }
    const claimed = await this.db.client.from('github_runner_tasks').update({ state: 'claimed', workflow_run_id: runId, claimed_at: new Date().toISOString() }).eq('id', taskId).eq('state', 'pending').select('id').maybeSingle();
    if (!this.db.unwrap(claimed, 'Unable to claim GitHub runner task')) throw new UnauthorizedException('GitHub runner task was already claimed');
    return JSON.parse(this.secrets.decrypt({ ciphertext: task.config_ciphertext, iv: task.config_iv, tag: task.config_tag })) as { gost: ProvisionNodeInput['gost'] };
  }

  async cancel(taskId: string) {
    const result = await this.db.client.from('github_runner_tasks').update({ state: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', taskId).in('state', ['pending', 'claimed']).select('github_owner,repository,workflow_run_id').maybeSingle();
    return this.db.unwrap(result, 'Unable to cancel GitHub runner task') as Pick<TaskRow, 'github_owner' | 'repository' | 'workflow_run_id'> | null;
  }

  async instance(taskId: string): Promise<ProviderInstance> {
    const result = await this.db.client.from('github_runner_tasks').select('id,state,expires_at,claimed_at,created_at').eq('id', taskId).maybeSingle();
    const task = this.db.unwrap(result, 'Unable to load GitHub runner task') as Pick<TaskRow, 'id' | 'state' | 'expires_at' | 'claimed_at' | 'created_at'> | null;
    if (!task) return { externalInstanceId: taskId, status: 'stopped' };
    const status: ProviderInstance['status'] = task.state === 'claimed' ? 'running' : task.state === 'pending' ? 'provisioning' : task.state === 'failed' ? 'error' : 'stopped';
    return { externalInstanceId: task.id, status, startedAt: task.claimed_at ? new Date(task.claimed_at) : new Date(task.created_at), expiresAt: new Date(task.expires_at) };
  }

  async ownedInstances(owner: string) {
    const result = await this.db.client.from('github_runner_tasks').select('id,state,expires_at,claimed_at,created_at').eq('github_owner', owner).in('state', ['pending', 'claimed']);
    const tasks = this.db.unwrap(result, 'Unable to list GitHub runner tasks') as Array<Pick<TaskRow, 'id' | 'state' | 'expires_at' | 'claimed_at' | 'created_at'>>;
    return tasks.map(task => ({ externalInstanceId: task.id, status: task.state === 'claimed' ? 'running' as const : 'provisioning' as const, startedAt: task.claimed_at ? new Date(task.claimed_at) : new Date(task.created_at), expiresAt: new Date(task.expires_at) }));
  }

  controlPlaneUrl() {
    const value = String(this.config.get('GITHUB_CONTROL_PLANE_URL') || '').replace(/\/$/, '');
    if (!/^https:\/\//.test(value)) throw new BadRequestException('GITHUB_CONTROL_PLANE_URL must be an HTTPS URL');
    return value;
  }

  private async verifyOidc(token: string): Promise<Claims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Invalid GitHub OIDC token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Claims;
    if (header.alg !== 'RS256' || !header.kid) throw new UnauthorizedException('Unsupported GitHub OIDC token');
    const audience = String(this.config.get('GITHUB_OIDC_AUDIENCE') || 'nodenesia-gost-control-plane');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== 'https://token.actions.githubusercontent.com' || !audiences.includes(audience) || !claims.exp || claims.exp * 1000 <= Date.now() || (claims.nbf && claims.nbf * 1000 > Date.now())) throw new UnauthorizedException('Expired or invalid GitHub OIDC claims');
    const key = (await this.githubJwks()).keys?.find(item => item.kid === header.kid);
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new UnauthorizedException('Invalid GitHub OIDC signature');
    return claims;
  }

  private async githubJwks() {
    if (this.jwks && this.jwksExpiresAt > Date.now()) return this.jwks;
    const response = await fetch('https://token.actions.githubusercontent.com/.well-known/jwks');
    if (!response.ok) throw new UnauthorizedException('Unable to verify GitHub OIDC identity');
    this.jwks = await response.json() as { keys?: GithubJwk[] };
    this.jwksExpiresAt = Date.now() + 60 * 60_000;
    return this.jwks;
  }
}
