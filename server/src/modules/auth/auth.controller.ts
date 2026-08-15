import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from './current-user.decorator';
import type { AuthUser } from './auth.types';

@Controller('auth')
export class AuthController {
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return {
      id: user.profileId,
      email: user.email,
      name: user.name,
      role: user.role,
      isTrial: user.isTrial,
      aal: user.aal,
    };
  }
}
