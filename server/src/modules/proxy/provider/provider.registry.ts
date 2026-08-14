import type { ComputeProvider } from './compute-provider';

export class ProviderRegistry {
  private readonly providers = new Map<string, ComputeProvider>();

  register(provider: ComputeProvider) {
    if (this.providers.has(provider.type)) throw new Error(`Provider adapter already registered: ${provider.type}`);
    this.providers.set(provider.type, provider);
  }

  get(type: string): ComputeProvider {
    const provider = this.providers.get(type);
    if (!provider) throw new Error(`Provider adapter is not registered: ${type}`);
    return provider;
  }

  supports(type: string) {
    return this.providers.has(type);
  }
}
