import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from './current-user.decorator';
import type { AuthUser } from './auth.types';
import { AllowPendingVerification } from './allow-pending-verification.decorator';

@Controller('auth')
export class AuthController {
  @Get('me')
  @AllowPendingVerification()
  me(@CurrentUser() user: AuthUser) {
    return {
      id: user.profileId,
      email: user.email,
      name: user.name,
      role: user.role,
      isTrial: user.isTrial,
      onboardingStatus: user.onboardingStatus,
      aal: user.aal,
    };
  }
}
