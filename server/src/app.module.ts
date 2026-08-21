import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './common/security/rate-limit.guard';
import { AdminModule } from './modules/admin/admin.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { DatabaseModule } from './modules/database/database.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthController } from './modules/health.controller';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProxyModule } from './modules/proxy/proxy.module';
import { StaticResidentialModule } from './modules/static-residential/static-residential.module';
import { TelegramOnboardingModule } from './modules/telegram-onboarding/telegram-onboarding.module';
import { TempMailModule } from './modules/temp-mail/temp-mail.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    CatalogModule,
    OrdersModule,
    PaymentsModule,
    DashboardModule,
    AdminModule,
    ProxyModule,
    StaticResidentialModule,
    TelegramOnboardingModule,
    TempMailModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
