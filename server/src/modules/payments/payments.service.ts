import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import type { CreateSumopodCheckoutDto } from './payments.dto';

type SumopodWebhook = {
  event_type?: string;
  data?: { payment_id?: string; order_id?: string; amount?: number; fee?: number; net_amount?: number; status?: string; completed_at?: string };
};
type SumopodCreatePaymentResponse = {
  payment_id?: string; payment_link_url?: string; expires_at?: string;
  fee?: number; net_amount?: number; status?: string; message?: string; error?: string;
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  constructor(private readonly db: DatabaseService, private readonly config: ConfigService) {}

  async createSumopodCheckout(profileId: number, isAdmin: boolean, dto: CreateSumopodCheckoutDto) {
    this.assertCheckoutEnabled(isAdmin);
    const apiKey = this.requiredConfig('SUMOPOD_API_KEY');
    const baseUrl = (this.config.get<string>('SUMOPOD_API_BASE_URL') || 'https://api-pay-sandbox.sumopod.com/api/v1').replace(/\/+$/, '');
    const successUrl = this.optionalHttpsCallback('SUMOPOD_SUCCESS_RETURN_URL');
    const cancelUrl = this.optionalHttpsCallback('SUMOPOD_CANCEL_RETURN_URL');

    const settingsResult = await this.db.client.from('app_settings').select('key,value').in('key', ['credits_per_usd', 'usd_to_idr_rate']);
    const settings = this.db.unwrap(settingsResult, 'Unable to load credit conversion settings');
    const values = Object.fromEntries(settings.map(row => [row.key, Number(row.value)]));
    if (!Number.isFinite(values.credits_per_usd) || values.credits_per_usd <= 0 || !Number.isFinite(values.usd_to_idr_rate) || values.usd_to_idr_rate <= 0) {
      throw new BadRequestException('Credit conversion settings are invalid');
    }
    // This is only a temporary non-zero value required by the existing schema.
    // It is replaced with the provider-settled net amount before a link is returned.
    const provisionalCreditAmount = this.creditForIdr(dto.amountIdr, values);
    if (!Number.isFinite(provisionalCreditAmount) || provisionalCreditAmount <= 0) throw new BadRequestException('Top-up amount is too small');

    const merchantOrderId = `NODENESIA-SUMO-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const invoiceResult = await this.db.client.from('payment_invoices').insert({
      profile_id: profileId, provider: 'sumopod', merchant_order_id: merchantOrderId,
      amount_idr: dto.amountIdr, credit_amount: provisionalCreditAmount, expires_at: expiresAt,
    }).select('id').single();
    const invoice = this.db.unwrap(invoiceResult, 'Unable to create payment invoice');

    try {
      const response = await fetch(`${baseUrl}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ order_id: merchantOrderId, amount: dto.amountIdr, currency: 'IDR', expires_in_hours: 24, ...(successUrl ? { success_return_url: successUrl } : {}), ...(cancelUrl ? { cancel_return_url: cancelUrl } : {}), payment_method_type_code: dto.paymentMethod }),
        signal: AbortSignal.timeout(8_000),
      });
      const responseText = await response.text();
      let payload: SumopodCreatePaymentResponse | null = null;
      try { payload = JSON.parse(responseText) as SumopodCreatePaymentResponse; } catch { /* handled below with a bounded diagnostic */ }
      if (!response.ok || !payload?.payment_id || !payload.payment_link_url || payload.status !== 'pending') {
        const providerMessage = String(payload?.message || payload?.error || responseText || 'empty response').replace(/[\r\n]+/g, ' ').slice(0, 300);
        throw new Error(`Sumopod HTTP ${response.status}: ${providerMessage}`);
      }
      const url = this.parsePaymentUrl(payload.payment_link_url, baseUrl);
      const returnedFeeIdr = this.optionalProviderMoney(payload.fee, 'fee');
      const returnedNetAmountIdr = this.optionalProviderMoney(payload.net_amount, 'net amount');
      const feeIdr = returnedFeeIdr ?? (returnedNetAmountIdr === null ? null : dto.amountIdr - returnedNetAmountIdr);
      const netAmountIdr = returnedNetAmountIdr ?? (returnedFeeIdr === null ? null : dto.amountIdr - returnedFeeIdr);
      if (feeIdr === null || netAmountIdr === null || feeIdr < 0 || netAmountIdr <= 0 || netAmountIdr > dto.amountIdr || feeIdr + netAmountIdr !== dto.amountIdr) {
        this.logger.warn(`Sumopod invalid settlement for invoice ${invoice.id}: gross=${dto.amountIdr}, fee=${String(payload.fee)}, net=${String(payload.net_amount)}`);
        throw new Error('Sumopod returned invalid fee settlement');
      }
      const creditAmount = this.creditForIdr(netAmountIdr, values);
      if (!Number.isFinite(creditAmount) || creditAmount <= 0) throw new Error('Sumopod net settlement is too small');
      const update = await this.db.client.from('payment_invoices').update({
        provider_payment_id: payload.payment_id, provider_fee_idr: feeIdr, net_amount_idr: netAmountIdr,
        credit_amount: creditAmount, expires_at: payload.expires_at || expiresAt, updated_at: new Date().toISOString(),
      }).eq('id', invoice.id).eq('status', 'pending');
      this.db.unwrap(update, 'Unable to finalize payment invoice');
      return { invoiceId: invoice.id, paymentUrl: url, expiresAt: payload.expires_at || expiresAt, creditAmount, amountIdr: dto.amountIdr, feeIdr, netAmountIdr };
    } catch (error) {
      // A timeout or malformed success response is ambiguous: the provider may
      // have created the payment and may still send a valid webhook. Do not
      // reject that payment locally. Only a definite non-2xx provider response
      // closes the invoice; all other pending invoices expire naturally.
      if (error instanceof Error && /^Sumopod HTTP [45]\d{2}:/.test(error.message)) {
        await this.db.client.from('payment_invoices').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', invoice.id).eq('status', 'pending');
      }
      if (error instanceof BadRequestException) throw error;
      this.logger.warn(`Sumopod checkout failed for invoice ${invoice.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new BadGatewayException('Unable to create Sumopod payment link');
    }
  }

  async handleSumopodWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer) {
    this.assertPaymentsEnabled();
    this.verifyWebhookAuthenticity(headers, rawBody);
    let event: SumopodWebhook;
    try { event = JSON.parse(rawBody.toString('utf8')) as SumopodWebhook; } catch { throw new BadRequestException('Invalid Sumopod webhook JSON'); }
    if (event.event_type === 'payment.failed' || event.event_type === 'payment.expired') {
      const orderId = event.data?.order_id;
      if (!orderId || !/^NODENESIA-SUMO-[0-9a-f-]{36}$/.test(orderId)) throw new BadRequestException('Invalid Sumopod terminal payment payload');
      const status = event.event_type === 'payment.expired' ? 'expired' : 'failed';
      const update = await this.db.client.from('payment_invoices')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('merchant_order_id', orderId)
        .eq('status', 'pending');
      this.db.unwrap(update, 'Unable to update Sumopod payment status');
      return { received: true };
    }
    if (event.event_type !== 'payment.completed') return { received: true };
    const data = event.data;
    const amount = Number(data?.amount);
    const feeIdr = data?.fee === undefined ? null : this.parseProviderMoney(data.fee, 'webhook fee');
    const netAmountIdr = data?.net_amount === undefined ? null : this.parseProviderMoney(data.net_amount, 'webhook net amount');
    if (!data?.payment_id || !data.order_id || !Number.isInteger(amount) || amount <= 0 || data.status !== 'completed') {
      throw new BadRequestException('Invalid Sumopod completed payment payload');
    }
    if ((data?.fee !== undefined && feeIdr === null) || (data?.net_amount !== undefined && netAmountIdr === null)) {
      throw new BadRequestException('Invalid Sumopod settlement payload');
    }
    const completedAt = data.completed_at ? new Date(data.completed_at) : new Date();
    if (Number.isNaN(completedAt.getTime())) throw new BadRequestException('Invalid Sumopod completion timestamp');
    const result = await this.db.client.rpc('complete_sumopod_credit_payment', {
      target_merchant_order_id: data.order_id,
      target_payment_id: data.payment_id,
      target_event_id: this.optionalOneHeader(headers['svix-id']) || `sumopod-token-${data.payment_id}`,
      target_amount_idr: amount,
      target_fee_idr: feeIdr,
      target_net_amount_idr: netAmountIdr,
      target_currency: 'IDR',
      target_completed_at: completedAt.toISOString(),
    });
    const balance = Number(this.db.unwrap(result, 'Unable to complete Sumopod payment'));
    return { received: true, balance };
  }

  async invoiceStatus(profileId: number, invoiceId: string) {
    this.assertPaymentsEnabled();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(invoiceId)) throw new BadRequestException('Invalid payment invoice');
    const result = await this.db.client.from('payment_invoices')
      .select('id,status,amount_idr,provider_fee_idr,net_amount_idr,credit_amount,expires_at,completed_at')
      .eq('id', invoiceId).eq('profile_id', profileId).eq('provider', 'sumopod').maybeSingle();
    const invoice = this.db.unwrap(result, 'Unable to load payment invoice');
    if (!invoice) throw new BadRequestException('Payment invoice not found');
    return { id: invoice.id, status: invoice.status, amountIdr: Number(invoice.amount_idr), feeIdr: invoice.provider_fee_idr === null ? null : Number(invoice.provider_fee_idr), netAmountIdr: invoice.net_amount_idr === null ? null : Number(invoice.net_amount_idr), creditAmount: Number(invoice.credit_amount), expiresAt: invoice.expires_at, completedAt: invoice.completed_at };
  }

  private assertPaymentsEnabled() {
    if (this.config.get<string>('SUMOPOD_ENABLED') !== 'true') {
      throw new ServiceUnavailableException('Sumopod payments are disabled');
    }
    const mode = this.sumopodMode();
    const baseUrl = (this.config.get<string>('SUMOPOD_API_BASE_URL') || '').replace(/\/+$/, '');
    const expectedBaseUrl = mode === 'production'
      ? 'https://api-pay.sumopod.com/api/v1'
      : 'https://api-pay-sandbox.sumopod.com/api/v1';
    if (baseUrl !== expectedBaseUrl) {
      throw new ServiceUnavailableException(`SUMOPOD_API_BASE_URL must use the ${mode} Sumopod endpoint`);
    }
  }

  private assertCheckoutEnabled(isAdmin: boolean) {
    this.assertPaymentsEnabled();
    if (!isAdmin && this.config.get<string>('SUMOPOD_CUSTOMER_TOPUPS_ENABLED') !== 'true') {
      throw new ForbiddenException('Credit top-ups are not available to customers yet');
    }
  }

  private sumopodMode(): 'sandbox' | 'production' {
    const mode = this.config.get<string>('SUMOPOD_MODE')?.trim().toLowerCase() || 'sandbox';
    if (mode !== 'sandbox' && mode !== 'production') {
      throw new ServiceUnavailableException('SUMOPOD_MODE must be sandbox or production');
    }
    return mode;
  }

  private requiredConfig(key: string) {
    const value = this.config.get<string>(key)?.trim();
    if (!value) throw new ServiceUnavailableException(`${key} is not configured`);
    return value;
  }

  private creditForIdr(amountIdr: number, values: Record<string, number>) {
    return Number(((amountIdr / values.usd_to_idr_rate) * values.credits_per_usd).toFixed(2));
  }

  private parseProviderMoney(value: unknown, field: string) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount)) {
      this.logger.warn(`Sumopod returned invalid ${field}`);
      return null;
    }
    return amount;
  }

  private optionalProviderMoney(value: unknown, field: string) {
    return value === undefined || value === null ? null : this.parseProviderMoney(value, field);
  }

  private optionalHttpsCallback(key: string) {
    const value = this.config.get<string>(key)?.trim();
    if (!value) return undefined;
    let url: URL;
    try { url = new URL(value); } catch { throw new ServiceUnavailableException(`${key} must be a valid HTTPS URL`); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new ServiceUnavailableException(`${key} must be a safe HTTPS URL`);
    return url.toString();
  }

  private parsePaymentUrl(value: string, apiBaseUrl: string) {
    let url: URL;
    try { url = new URL(value); } catch { throw new BadGatewayException('Sumopod returned an invalid payment URL'); }
    const apiHost = new URL(apiBaseUrl).hostname;
    const allowedHosts = apiHost === 'api-pay-sandbox.sumopod.com'
      // The Sumopod sandbox currently serves hosted checkout from this
      // separately branded origin. Keep this an exact allowlist rather than
      // allowing arbitrary `*.pymnt.global` redirect hosts.
      ? new Set(['pay-sandbox.sumopod.com', 'pay.sumopod.com', 'sumo.sandbox.pymnt.global'])
      // Live Sumopod currently serves the hosted checkout from this exact
      // origin. Do not broaden this to a pymnt.app wildcard: the checkout URL
      // can contain a live, one-time payment token.
      : new Set(['pay.sumopod.com', 'checkout.pymnt.app']);
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password) {
      // Deliberately log only origin metadata; the path/query can contain a
      // live payment token and must never reach application logs.
      throw new BadGatewayException(`Sumopod returned an untrusted payment origin: ${url.protocol}//${url.hostname}`);
    }
    return url.toString();
  }

  private verifySvixSignature(id: string, timestamp: string, signatureHeader: string, rawBody: Buffer) {
    const timestampSeconds = Number(timestamp);
    if (!Number.isInteger(timestampSeconds) || Math.abs(Date.now() - timestampSeconds * 1000) > 5 * 60_000) throw new UnauthorizedException('Expired Sumopod webhook signature');
    const secret = this.requiredConfig('SUMOPOD_WEBHOOK_SECRET');
    if (!secret.startsWith('whsec_')) throw new ServiceUnavailableException('SUMOPOD_WEBHOOK_SECRET is invalid');
    const secretBytes = Buffer.from(secret.slice(6), 'base64');
    if (!secretBytes.length) throw new ServiceUnavailableException('SUMOPOD_WEBHOOK_SECRET is invalid');
    const expected = createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${rawBody.toString('utf8')}`).digest('base64');
    const signatures = signatureHeader.split(' ').map(part => part.split(',', 2)).filter(([version, signature]) => version === 'v1' && Boolean(signature)).map(([, signature]) => signature);
    if (!signatures.some(signature => this.safeEqual(signature, expected))) throw new UnauthorizedException('Invalid Sumopod webhook signature');
  }

  private verifyWebhookAuthenticity(headers: Record<string, string | string[] | undefined>, rawBody: Buffer) {
    // A static webhook token is useful for the Sumopod sandbox tester but is
    // deliberately not accepted for live money movement. Production requires
    // Svix's timestamped, replay-resistant HMAC signature.
    if (this.sumopodMode() === 'production') {
      const svixId = this.optionalOneHeader(headers['svix-id']);
      const svixTimestamp = this.optionalOneHeader(headers['svix-timestamp']);
      const svixSignature = this.optionalOneHeader(headers['svix-signature']);
      if (!svixId || !svixTimestamp || !svixSignature) throw new UnauthorizedException('Missing Sumopod webhook signature');
      this.verifySvixSignature(svixId, svixTimestamp, svixSignature, rawBody);
      return;
    }
    const suppliedToken = this.optionalOneHeader(headers['x-webhook-token']);
    const expectedToken = this.config.get<string>('SUMOPOD_WEBHOOK_TOKEN')?.trim();
    if (suppliedToken && expectedToken && this.safeEqual(suppliedToken, expectedToken)) return;
    const svixId = this.optionalOneHeader(headers['svix-id']);
    const svixTimestamp = this.optionalOneHeader(headers['svix-timestamp']);
    const svixSignature = this.optionalOneHeader(headers['svix-signature']);
    if (!svixId || !svixTimestamp || !svixSignature) throw new UnauthorizedException('Missing Sumopod webhook signature or token');
    this.verifySvixSignature(svixId, svixTimestamp, svixSignature, rawBody);
  }

  private oneHeader(value: string | string[] | undefined) {
    if (typeof value !== 'string' || !value || value.length > 2_000) throw new UnauthorizedException('Missing Sumopod webhook signature');
    return value;
  }

  private optionalOneHeader(value: string | string[] | undefined) {
    return typeof value === 'string' && value.length > 0 && value.length <= 2_000 ? value : undefined;
  }

  private safeEqual(left: string, right: string) {
    const a = Buffer.from(left); const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
