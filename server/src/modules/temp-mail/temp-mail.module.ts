import { Module } from '@nestjs/common';
import { TempMailController } from './temp-mail.controller';
import { TempMailService } from './temp-mail.service';

@Module({ controllers: [TempMailController], providers: [TempMailService] })
export class TempMailModule {}
