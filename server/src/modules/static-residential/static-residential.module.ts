import { Module } from '@nestjs/common';
import { ProxyModule } from '../proxy/proxy.module';
import { AdminStaticResidentialController, StaticResidentialController } from './static-residential.controller';
import { StaticGostService } from './static-gost.service';
import { StaticResidentialService } from './static-residential.service';

@Module({
  imports: [ProxyModule],
  controllers: [StaticResidentialController, AdminStaticResidentialController],
  providers: [StaticResidentialService, StaticGostService],
  exports: [StaticResidentialService],
})
export class StaticResidentialModule {}
