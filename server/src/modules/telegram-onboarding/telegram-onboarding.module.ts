import { Module } from '@nestjs/common';
import { TelegramOnboardingController } from './telegram-onboarding.controller';
import { TelegramOnboardingService } from './telegram-onboarding.service';

@Module({
  controllers: [TelegramOnboardingController],
  providers: [TelegramOnboardingService],
})
export class TelegramOnboardingModule {}
