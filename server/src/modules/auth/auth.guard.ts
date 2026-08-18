import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import { IS_PUBLIC } from './public.decorator';
import { ALLOW_PENDING_VERIFICATION } from './allow-pending-verification.decorator';
import type { AuthUser } from './auth.types';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<Request & { user: AuthUser }>();
    const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Missing bearer token');
    const { data, error } = await this.db.client.auth.getUser(token);
    if (error || !data.user?.email || !data.user.email_confirmed_at) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    const profile = await this.resolveProfile(data.user.id, data.user.email, data.user.user_metadata);
    request.user = { ...profile, aal: this.readAal(token) };
    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_VERIFICATION, [context.getHandler(), context.getClass()]);
    if (profile.onboardingStatus !== 'verified' && !allowPending) {
      throw new ForbiddenException({
        code: 'TELEGRAM_VERIFICATION_REQUIRED',
        message: 'Verify your Telegram account to continue',
      });
    }
    return true;
  }

  private async resolveProfile(authUserId: string, rawEmail: string, metadata: Record<string, unknown>): Promise<Omit<AuthUser, 'aal'>> {
    const email = rawEmail.toLowerCase();
    const metadataName = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    const name = (metadataName || email.split('@')[0]).slice(0, 80);
    const fields = 'id,role,status,email,name,is_trial,onboarding_status';
    const existingResult = await this.db.client.from('profiles').select(fields).eq('auth_user_id', authUserId).maybeSingle();
    if (existingResult.error) throw existingResult.error;
    let profile = existingResult.data;
    if (!profile) {
      const result = await this.db.client.from('profiles')
        .insert({ auth_user_id: authUserId, email, name, role: 'client' })
        .select(fields).single();
      if (result.error) throw result.error;
      profile = result.data;
    }
    if (profile.status !== 'active') throw new UnauthorizedException('Account is suspended');
    return {
      authUserId,
      profileId: profile.id,
      role: profile.role,
      email: profile.email,
      name: profile.name,
      isTrial: profile.is_trial,
      onboardingStatus: profile.onboarding_status,
    };
  }

  private readAal(token: string): 'aal1' | 'aal2' {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { aal?: string };
      return payload.aal === 'aal2' ? 'aal2' : 'aal1';
    } catch {
      return 'aal1';
    }
  }
}
