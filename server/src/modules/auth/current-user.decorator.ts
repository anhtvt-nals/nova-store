import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from './auth.types';

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser =>
  (context.switchToHttp().getRequest<Request>() as Request & { user: AuthUser }).user,
);
