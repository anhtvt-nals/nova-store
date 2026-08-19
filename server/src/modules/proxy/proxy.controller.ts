import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query, Sse } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { Public } from '../auth/public.decorator';
import { ProxyEventsService } from './proxy-events.service';
import { ProxyService } from './proxy.service';
import { RecreateAllProxyNodesDto } from './proxy.dto';

@Controller('client/proxy')
export class ProxyController {
  constructor(
    private readonly proxy: ProxyService,
    private readonly events: ProxyEventsService,
  ) {}

  @Get('nodes')
  nodes(@CurrentUser() user: AuthUser) {
    return this.proxy.listForUser(user.profileId);
  }

  @Post('nodes/:id/restart')
  restartNode(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.proxy.restartForUser(user.profileId, id);
  }

  // A signed bearer URL is intentionally available as GET for integrations
  // that need to invoke it directly without a custom HTTP method.
  @Public()
  @Get('nodes/:id/rotate')
  rotateNodeWithUrl(@Param('id', ParseIntPipe) id: number, @Query('token') token?: string) {
    return this.proxy.restartWithRotationUrl(id, token);
  }

  @Post('nodes/recreate-all')
  recreateAllNodes(@CurrentUser() user: AuthUser, @Body() dto: RecreateAllProxyNodesDto) {
    return this.proxy.recreateAllForUser(user.profileId, dto?.proxyType);
  }

  @Sse('nodes/events')
  nodeEvents(
    @CurrentUser() user: AuthUser,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<MessageEvent> {
    return this.events.stream(user.profileId, lastEventId);
  }
}
