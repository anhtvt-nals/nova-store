import { Controller, Get, Headers, Sse } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ProxyEventsService } from './proxy-events.service';
import { ProxyService } from './proxy.service';

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

  @Sse('nodes/events')
  nodeEvents(
    @CurrentUser() user: AuthUser,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<MessageEvent> {
    return this.events.stream(user.profileId, lastEventId);
  }
}

