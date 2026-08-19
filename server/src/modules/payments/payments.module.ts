import { Module } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({ controllers: [PaymentsController], providers: [PaymentsService, AdminGuard] })
export class PaymentsModule {}
