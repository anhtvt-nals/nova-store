import { Controller, Get, Query } from '@nestjs/common';
import { TempMailMessagesDto } from './temp-mail.dto';
import { TempMailService } from './temp-mail.service';

@Controller('temp-mail')
export class TempMailController {
  constructor(private readonly service: TempMailService) {}

  @Get('domains') domains() { return this.service.listDomains(); }

  @Get('messages') messages(@Query() query: TempMailMessagesDto) {
    return this.service.listMessages(query.address);
  }
}
