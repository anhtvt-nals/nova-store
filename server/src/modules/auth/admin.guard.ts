import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AuthUser } from './auth.types';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const user = (context.switchToHttp().getRequest<Request>() as Request & { user: AuthUser }).user;
    if (user?.role !== 'admin') throw new ForbiddenException('Admin access required');
    if (this.config.get<string>('ADMIN_REQUIRE_MFA') !== 'false' && user.aal !== 'aal2') {
      throw new ForbiddenException('Admin multi-factor authentication is required');
    }
    return true;
  }
}
