import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { Public } from '../auth/public.decorator';
import { CreateSumopodCheckoutDto } from './payments.dto';
import { PaymentsService } from './payments.service';

type RawRequest = Request & { rawBody?: Buffer };

@Controller('payments/sumopod')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Post('checkout')
  checkout(@CurrentUser() user: AuthUser, @Body() body: CreateSumopodCheckoutDto) {
    return this.service.createSumopodCheckout(user.profileId, user.role === 'admin', body);
  }

  @Get('invoices')
  invoices(@CurrentUser() user: AuthUser) {
    return this.service.invoices(user.profileId);
  }

  @Get('invoices/:id')
  invoiceStatus(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.invoiceStatus(user.profileId, id);
  }

  @Public()
  @Post('webhook')
  @HttpCode(204)
  async webhook(@Req() request: RawRequest, @Headers() headers: Record<string, string | string[] | undefined>) {
    if (!request.rawBody) throw new Error('Raw webhook body is unavailable');
    await this.service.handleSumopodWebhook(headers, request.rawBody);
  }
}
