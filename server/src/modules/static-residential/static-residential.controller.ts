import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CreateStaticResidentialOrderDto, ExtendStaticResidentialOrderDto, ImportStaticResidentialProxiesDto, UpdateStaticResidentialPricingDto } from './static-residential.dto';
import { StaticResidentialService } from './static-residential.service';

@Controller('static-residential')
export class StaticResidentialController {
  constructor(private readonly service: StaticResidentialService) {}
  @Get('orders') list(@CurrentUser() user: AuthUser) { return this.service.listForUser(user.profileId); }
  @Post('quote') quote(@Body() body: CreateStaticResidentialOrderDto) { return this.service.quote(body.rentalDays, body.quotaGb); }
  @Post('orders') create(@CurrentUser() user: AuthUser, @Body() body: CreateStaticResidentialOrderDto) { return this.service.create(user.profileId, body.rentalDays, body.quotaGb); }
  @Post('orders/:id/extend') extend(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() body: ExtendStaticResidentialOrderDto) { return this.service.extend(user.profileId, id, body.rentalDays); }
  @Get('connections/export') export(@CurrentUser() user: AuthUser) { return this.service.exportConnections(user.profileId); }
}

@UseGuards(AdminGuard)
@Controller('admin/static-residential')
export class AdminStaticResidentialController {
  constructor(private readonly service: StaticResidentialService) {}
  @Get('inventory') inventory(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.service.adminInventory(Number(page), Number(pageSize));
  }
  @Post('inventory/import') import(@Body() body: ImportStaticResidentialProxiesDto) { return this.service.importInventory(body.content, body.label); }
  @Get('pricing') pricing() { return this.service.pricing(); }
  @Patch('pricing') updatePricing(@Body() body: UpdateStaticResidentialPricingDto) { return this.service.updatePricing(body.pricePerGbDay); }
}
