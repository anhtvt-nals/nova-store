import { Body, Controller, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { ProxyUsageService } from './proxy-usage.service';

@Public()
@Controller('internal/proxy-usage')
export class ProxyUsageController {
  constructor(private readonly usage: ProxyUsageService) {}

  @Post(':nodeId')
  observe(
    @Param('nodeId', ParseIntPipe) nodeId: number,
    @Query('token') token: string | undefined,
    @Body() body: { events?: unknown[] },
  ) {
    return this.usage.observe(nodeId, token, body);
  }
}
