import { Module } from '@nestjs/common';
import { ProviderRegistry } from './provider/provider.registry';
import { E2bProvider } from './provider/e2b.provider';
import { RunloopProvider } from './provider/runloop.provider';
import { BlaxelProvider } from './provider/blaxel.provider';
import { GithubActionsProvider } from './provider/github-actions.provider';
import { GithubActionsControlPlaneService } from './provider/github-actions-control-plane.service';
import { GostCommandBuilder } from './gost/gost-command.builder';
import { SocksHealthService } from './gost/socks-health.service';
import { ProvisioningProcessor } from './provisioning/provisioning.processor';
import { ProvisioningRepository } from './provisioning/provisioning.repository';
import { ProxyCredentialService } from './proxy-credential.service';
import { ProxySecretService } from './proxy-secret.service';
import { ProxyEventsService } from './proxy-events.service';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { GithubRunnersController } from './github-runners.controller';
import { ProxyUsageController } from './proxy-usage.controller';
import { ProxyUsageService } from './proxy-usage.service';

@Module({
  // External workers are not accepted over HTTP. Provisioning runs inside this
  // module and writes through service-role RPCs with job ownership checks.
  controllers: [ProxyController, GithubRunnersController, ProxyUsageController],
  providers: [
    ProxyService,
    ProxyEventsService,
    ProxySecretService,
    ProxyCredentialService,
    ProxyUsageService,
    GostCommandBuilder,
    SocksHealthService,
    E2bProvider,
    RunloopProvider,
    BlaxelProvider,
    GithubActionsControlPlaneService,
    GithubActionsProvider,
    ProvisioningRepository,
    ProvisioningProcessor,
    {
      provide: ProviderRegistry,
      useFactory: (e2b: E2bProvider, runloop: RunloopProvider, blaxel: BlaxelProvider, github: GithubActionsProvider) => {
        const registry = new ProviderRegistry();
        registry.register(e2b);
        registry.register(runloop);
        registry.register(blaxel);
        registry.register(github);
        return registry;
      },
      inject: [E2bProvider, RunloopProvider, BlaxelProvider, GithubActionsProvider],
    },
  ],
  exports: [ProxyService, ProxyCredentialService, ProxySecretService, ProviderRegistry],
})
export class ProxyModule {}
