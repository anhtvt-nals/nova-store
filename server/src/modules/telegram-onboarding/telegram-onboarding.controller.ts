import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { AllowPendingVerification } from '../auth/allow-pending-verification.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import type { AuthUser } from '../auth/auth.types';
import { TelegramOnboardingService } from './telegram-onboarding.service';

@Controller()
export class TelegramOnboardingController {
  constructor(private readonly onboarding: TelegramOnboardingService) {}

  @Post('trial/telegram/start')
  @AllowPendingVerification()
  start(@CurrentUser() user: AuthUser) {
    return this.onboarding.start(user);
  }

  @Get('trial/telegram/status')
  @AllowPendingVerification()
  status(@CurrentUser() user: AuthUser) {
    return this.onboarding.status(user.profileId);
  }

  @Post('telegram/webhook/:pathSecret')
  @Public()
  webhook(
    @Param('pathSecret') pathSecret: string,
    @Headers('x-telegram-bot-api-secret-token') headerSecret: string | undefined,
    @Body() update: unknown,
  ) {
    return this.onboarding.webhook(pathSecret, headerSecret, update);
  }
}
