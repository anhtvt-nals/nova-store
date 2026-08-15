import { Module } from '@nestjs/common';
import { ProviderRegistry } from './provider/provider.registry';
import { E2bProvider } from './provider/e2b.provider';
import { RunloopProvider } from './provider/runloop.provider';
import { GostCommandBuilder } from './gost/gost-command.builder';
import { SocksHealthService } from './gost/socks-health.service';
import { ProvisioningProcessor } from './provisioning/provisioning.processor';
import { ProvisioningRepository } from './provisioning/provisioning.repository';
import { ProxyCredentialService } from './proxy-credential.service';
import { ProxySecretService } from './proxy-secret.service';
import { ProxyEventsService } from './proxy-events.service';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';

@Module({
  // External workers are not accepted over HTTP. Provisioning runs inside this
  // module and writes through service-role RPCs with job ownership checks.
  controllers: [ProxyController],
  providers: [
    ProxyService,
    ProxyEventsService,
    ProxySecretService,
    ProxyCredentialService,
    GostCommandBuilder,
    SocksHealthService,
    E2bProvider,
    RunloopProvider,
    ProvisioningRepository,
    ProvisioningProcessor,
    {
      provide: ProviderRegistry,
      useFactory: (e2b: E2bProvider, runloop: RunloopProvider) => {
        const registry = new ProviderRegistry();
        registry.register(e2b);
        registry.register(runloop);
        return registry;
      },
      inject: [E2bProvider, RunloopProvider],
    },
  ],
  exports: [ProxyService, ProxyCredentialService, ProviderRegistry],
})
export class ProxyModule {}
