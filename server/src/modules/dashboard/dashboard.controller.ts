import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { DashboardService } from './dashboard.service';

@Controller('client')
export class DashboardController {
  constructor(private service: DashboardService) {}
  @Get('overview') overview(@CurrentUser() user: AuthUser) { return this.service.clientOverview(user); }
}
