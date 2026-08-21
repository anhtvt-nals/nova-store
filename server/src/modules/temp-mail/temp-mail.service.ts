import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TempMailProvider {
  id: string;
  baseUrl: URL;
}

export interface TempMailMessage {
  id: string;
  from: string;
  subject: string;
  date: string | null;
  text: string | null;
  html: string | null;
}

@Injectable()
export class TempMailService {
  private readonly providers: TempMailProvider[];
  private domainsCache?: { expiresAt: number; domains: string[]; ownerByDomain: Map<string, TempMailProvider> };

  constructor(config: ConfigService) {
    const raw = String(config.get<string>('TEMP_MAIL_PROVIDER_URLS') || 'https://mailbox-get.hqmtindia.com/api').trim();
    this.providers = raw.split('|').map(value => value.trim()).filter(Boolean).map((value, index) => {
      let baseUrl: URL;
      try { baseUrl = new URL(value.endsWith('/') ? value : `${value}/`); }
      catch { throw new Error('TEMP_MAIL_PROVIDER_URLS contains an invalid URL'); }
      if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
        throw new Error('TEMP_MAIL_PROVIDER_URLS must use clean HTTPS API base URLs');
      }
      return { id: `provider-${index + 1}`, baseUrl };
    });
    if (!this.providers.length) throw new Error('At least one TEMP_MAIL_PROVIDER_URLS entry is required');
  }

  async listDomains() {
    const cache = await this.domains();
    return { domains: cache.domains };
  }

  async listMessages(rawAddress: string) {
    const address = rawAddress.trim().toLowerCase();
    const [local, domain] = address.split('@');
    if (!local || !domain || !/^[a-z0-9][a-z0-9._+-]{0,63}$/i.test(local)) {
      throw new BadRequestException('Invalid temporary email address');
    }
    const cache = await this.domains();
    const provider = cache.ownerByDomain.get(domain);
    if (!provider) throw new BadRequestException('This domain is not provided by the temporary mail service');
    const payload = await this.request(provider, `emails?address=${encodeURIComponent(address)}`);
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const items = Array.isArray(payload) ? payload : Array.isArray(record.emails) ? record.emails : Array.isArray(record.data) ? record.data : [];
    return { address, messages: items.slice(0, 100).map((item: unknown, index: number) => this.normalizeMessage(item, index)) };
  }

  private async domains() {
    if (this.domainsCache && this.domainsCache.expiresAt > Date.now()) return this.domainsCache;
    const responses = await Promise.allSettled(this.providers.map(async provider => ({ provider, payload: await this.request(provider, 'domains') })));
    const ownerByDomain = new Map<string, TempMailProvider>();
    for (const result of responses) {
      if (result.status !== 'fulfilled') continue;
      const { provider, payload } = result.value;
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const values = Array.isArray(payload) ? payload : Array.isArray(record.domains) ? record.domains : Array.isArray(record.data) ? record.data : [];
      for (const value of values) {
        const domain = String(typeof value === 'string' ? value : (value as any)?.domain || '').trim().toLowerCase();
        if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain) && !ownerByDomain.has(domain)) ownerByDomain.set(domain, provider);
      }
    }
    if (!ownerByDomain.size) throw new ServiceUnavailableException('Temporary mail providers are unavailable');
    const cache = { expiresAt: Date.now() + 5 * 60_000, domains: [...ownerByDomain.keys()].sort(), ownerByDomain };
    this.domainsCache = cache;
    return cache;
  }

  private async request(provider: TempMailProvider, path: string) {
    const url = new URL(path, provider.baseUrl);
    if (url.origin !== provider.baseUrl.origin || !url.pathname.startsWith(provider.baseUrl.pathname)) throw new BadGatewayException('Temporary mail provider URL rejected');
    let response: Response;
    try { response = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8_000) }); }
    catch { throw new ServiceUnavailableException('Temporary mail provider is unavailable'); }
    if (!response.ok) throw new BadGatewayException(`Temporary mail provider returned ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > 1_000_000) throw new BadGatewayException('Temporary mail provider response is too large');
    try { return await response.json() as unknown; }
    catch { throw new BadGatewayException('Temporary mail provider returned invalid JSON'); }
  }

  private normalizeMessage(value: unknown, index: number): TempMailMessage {
    const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const text = this.string(item.text ?? item.body ?? item.content ?? item.message);
    const html = this.string(item.html ?? item.html_body);
    return {
      id: this.string(item.id ?? item._id ?? item.message_id) || String(index),
      from: this.string(item.from ?? item.sender ?? item.from_address) || 'Unknown sender',
      subject: this.string(item.subject ?? item.title) || '(No subject)',
      date: this.string(item.date ?? item.created_at ?? item.received_at) || null,
      text: text ? text.slice(0, 100_000) : null,
      html: html ? html.slice(0, 100_000) : null,
    };
  }

  private string(value: unknown) { return typeof value === 'string' ? value : value == null ? '' : String(value); }
}
