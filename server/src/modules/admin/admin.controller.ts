import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { AdminService } from './admin.service';
import { AddCreditTopUpDto, AdjustCreditDto, BulkImportProviderApiKeysDto, CreateApiKeyDto, CreateBlaxelEgressGatewayDto, CreateCategoryDto, CreateProductDto, CreateProviderApiKeyDto, CreateProviderDto, CreateUserDto, DeductCreditDto, UpdateBlaxelEgressGatewayDto, UpdateCategoryDto, UpdateGeneralSettingsDto, UpdateOrderStatusDto, UpdateProductDto, UpdateProviderApiKeyDto, UpdateProviderDto, UpdateProxyPriceDto, UpdateUserDto } from './admin.dto';

@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private service: AdminService) {}
  @Get('overview') overview() { return this.service.overview(); }
  @Get('users') users(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    return page === undefined && !search
      ? this.service.users()
      : this.service.users(Number(page), Number(pageSize), search);
  }
  @Post('users') createUser(@Body() body: CreateUserDto) { return this.service.createUser(body); }
  @Patch('users/:id') updateUser(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateUserDto) { return this.service.updateUser(id, body); }
  @Post('users/:id/reset-password') resetUserPassword(@Param('id', ParseIntPipe) id: number) { return this.service.resetUserPassword(id); }
  @Get('credits') credits(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) { return this.service.credits(Number(page), Number(pageSize), search); }
  @Get('credits/:id/history') creditHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) { return this.service.creditHistory(id, Number(page), Number(pageSize)); }
  @Get('payment-invoices') paymentInvoices(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) { return this.service.paymentInvoices(Number(page), Number(pageSize)); }
  @Post('credits/:id/adjust') adjustCredit(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() body: AdjustCreditDto) { return this.service.adjustCredit(id, body.amount, body.note || '', user.profileId); }
  @Post('credits/:id/top-up') topUpCredit(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() body: AddCreditTopUpDto) { return this.service.topUpCredit(id, body.amount, body.currency, body.note || '', user.profileId); }
  @Post('credits/:id/deduct') deductCredit(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() body: DeductCreditDto) { return this.service.deductCredit(id, body.amount, body.note, user.profileId); }
  @Delete('users/:id') @HttpCode(204) deleteUser(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.service.deleteUser(id, user); }
  @Get('categories') categories() { return this.service.categories(); }
  @Post('categories') createCategory(@Body() body: CreateCategoryDto) { return this.service.createCategory(body); }
  @Patch('categories/:id') updateCategory(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateCategoryDto) { return this.service.updateCategory(id, body); }
  @Delete('categories/:id') @HttpCode(204) deleteCategory(@Param('id', ParseIntPipe) id: number) { return this.service.deleteCategory(id); }
  @Get('products') products() { return this.service.products(); }
  @Post('products') createProduct(@Body() body: CreateProductDto) { return this.service.createProduct(body); }
  @Patch('products/:id') updateProduct(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateProductDto) { return this.service.updateProduct(id, body); }
  @Delete('products/:id') @HttpCode(204) deleteProduct(@Param('id', ParseIntPipe) id: number) { return this.service.deleteProduct(id); }
  @Get('proxy/providers') providers() { return this.service.providers(); }
  @Post('proxy/providers') createProvider(@Body() body: CreateProviderDto) { return this.service.createProvider(body); }
  @Patch('proxy/providers/:id') updateProvider(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateProviderDto) { return this.service.updateProvider(id, body); }
  @Delete('proxy/providers/:id') @HttpCode(204) deleteProvider(@Param('id', ParseIntPipe) id: number) { return this.service.deleteProvider(id); }
  @Get('proxy/provider-api-keys') providerApiKeys() { return this.service.providerApiKeys(); }
  @Get('proxy/provisioning-jobs') provisioningJobs(@Query('page') page?: string) { return this.service.provisioningJobs(Number(page)); }
  @Post('proxy/providers/:id/api-keys') createProviderApiKey(@Param('id', ParseIntPipe) id: number, @Body() body: CreateProviderApiKeyDto) { return this.service.createProviderApiKey(id, body); }
  @Post('proxy/providers/:id/api-keys/bulk-import') bulkImportProviderApiKeys(@Param('id', ParseIntPipe) id: number, @Body() body: BulkImportProviderApiKeysDto) { return this.service.bulkImportProviderApiKeys(id, body.content, body.maxSandboxes); }
  @Patch('proxy/provider-api-keys/:id') updateProviderApiKey(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateProviderApiKeyDto) { return this.service.updateProviderApiKey(id, body); }
  @Delete('proxy/provider-api-keys/:id') @HttpCode(204) revokeProviderApiKey(@Param('id', ParseIntPipe) id: number) { return this.service.revokeProviderApiKey(id); }
  @Get('proxy/blaxel-egress-gateways') blaxelEgressGateways() { return this.service.blaxelEgressGateways(); }
  @Post('proxy/blaxel-egress-gateways') createBlaxelEgressGateway(@Body() body: CreateBlaxelEgressGatewayDto) { return this.service.createBlaxelEgressGateway(body); }
  @Patch('proxy/blaxel-egress-gateways/:id') updateBlaxelEgressGateway(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateBlaxelEgressGatewayDto) { return this.service.updateBlaxelEgressGateway(id, body); }
  @Delete('proxy/blaxel-egress-gateways/:id') @HttpCode(204) deleteBlaxelEgressGateway(@Param('id', ParseIntPipe) id: number) { return this.service.deleteBlaxelEgressGateway(id); }
  @Get('proxy/settings') proxySettings() { return this.service.proxySettings(); }
  @Patch('proxy/settings/:id') updateProxyPrice(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateProxyPriceDto) { return this.service.updateProxyPrice(id, body); }
  @Get('settings') generalSettings() { return this.service.generalSettings(); }
  @Patch('settings') updateGeneralSettings(@Body() body: UpdateGeneralSettingsDto) { return this.service.updateGeneralSettings(body); }
  @Get('api-keys') apiKeys() { return this.service.apiKeys(); }
  @Post('api-keys') createApiKey(@CurrentUser() user: AuthUser, @Body() body: CreateApiKeyDto) { return this.service.createApiKey(user.profileId, body.label); }
  @Delete('api-keys/:id') @HttpCode(204) revokeApiKey(@Param('id', ParseIntPipe) id: number) { return this.service.revokeApiKey(id); }
  @Get('orders') orders(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return page === undefined ? this.service.orders() : this.service.orders(Number(page), Number(pageSize));
  }
  @Patch('orders/:id/status') updateOrder(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() body: UpdateOrderStatusDto) { return this.service.updateOrder(id, body.status, user.profileId); }
  @Post('orders/:id/cancel') cancelOrder(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.service.cancelRunningProxyOrder(id, user.profileId); }
}
