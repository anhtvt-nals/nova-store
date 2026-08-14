import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CreateOrderDto, QuoteOrderDto } from './orders.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private service: OrdersService) {}
  @Get() list(@CurrentUser() user: AuthUser) { return this.service.listForUser(user.profileId); }
  @Post('quote') quote(@Body() body: QuoteOrderDto) { return this.service.quote(body); }
  @Post() create(@CurrentUser() user: AuthUser, @Body() body: CreateOrderDto) { return this.service.create(user.profileId, body); }
  @Get(':id/connection') connection(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.service.connection(user.profileId, id); }
  @Get(':id/nodes/:nodeId/connection') nodeConnection(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('nodeId', ParseIntPipe) nodeId: number) { return this.service.connection(user.profileId, id, nodeId); }
}
