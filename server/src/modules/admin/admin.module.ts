import { Module } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({ controllers: [AdminController], providers: [AdminService, AdminGuard] })
export class AdminModule {}
