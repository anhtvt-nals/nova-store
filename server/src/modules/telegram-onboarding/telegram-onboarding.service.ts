import {
  BadGatewayException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import type { AuthUser } from '../auth/auth.types';

type TelegramUser = { id?: number; username?: string; first_name?: string };
type TelegramChat = { id?: number; type?: string };
type TelegramChatMember = { status?: string; user?: TelegramUser; is_member?: boolean };
type TelegramUpdate = {
  update_id?: number;
  message?: { text?: string; chat?: TelegramChat; from?: TelegramUser };
  callback_query?: { id?: string; data?: string; from?: TelegramUser; message?: { chat?: TelegramChat } };
  chat_member?: { chat?: TelegramChat; new_chat_member?: TelegramChatMember };
};
type TelegramApiResponse<T> = { ok?: boolean; result?: T; description?: string };

@Injectable()
export class TelegramOnboardingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async status(profileId: number) {
    const result = await this.db.client
      .from('profiles')
      .select('onboarding_status,telegram_username,telegram_first_name,telegram_member_status,telegram_verified_at')
      .eq('id', profileId)
      .maybeSingle();
    const profile = this.db.unwrap(result, 'Unable to load Telegram verification status');
    if (!profile) throw new UnauthorizedException('Profile not found');
    return {
      onboardingStatus: profile.onboarding_status as 'telegram_pending' | 'verified',
      telegramUsername: profile.telegram_username as string | null,
      telegramFirstName: profile.telegram_first_name as string | null,
      memberStatus: profile.telegram_member_status as string | null,
      verifiedAt: profile.telegram_verified_at as string | null,
    };
  }

  async start(user: AuthUser) {
    if (user.role !== 'client') throw new ConflictException('Telegram onboarding is only available to client accounts');
    if (user.onboardingStatus === 'verified') {
      return { success: true, alreadyVerified: true, onboardingStatus: 'verified' as const };
    }

    const botUsername = this.botUsername();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + this.linkTokenTtlSeconds() * 1000);
    const result = await this.db.client.rpc('create_telegram_link_token', {
      target_profile_id: user.profileId,
      target_token_hash: tokenHash,
      target_expires_at: expiresAt.toISOString(),
    });
    if (result.error) this.throwDatabaseError(result.error.message, 'Unable to create Telegram verification link');

    return {
      success: true,
      telegramUrl: `https://t.me/${botUsername}?start=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async webhook(pathSecret: string, headerSecret: string | undefined, rawUpdate: unknown) {
    this.verifyWebhookSecrets(pathSecret, headerSecret);
    const update = this.parseUpdate(rawUpdate);
    if (update.message) await this.handleMessage(update);
    else if (update.callback_query) await this.handleCallback(update);
    else if (update.chat_member) await this.handleChatMember(update);
    return { ok: true };
  }

  private async handleMessage(update: TelegramUpdate) {
    const message = update.message;
    const chatId = message?.chat?.id;
    const user = message?.from;
    if (!chatId || message.chat?.type !== 'private' || !user?.id) return;
    const match = message.text?.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{20,64}))?$/);
    if (!match) return;
    if (!match[1]) {
      await this.sendMessage(chatId, 'Open the verification link from your Nodenesia account to continue.');
      return;
    }

    const tokenHash = this.hash(match[1]);
    const bind = await this.db.client.rpc('bind_telegram_link_token', {
      target_token_hash: tokenHash,
      target_telegram_user_id: String(user.id),
      target_telegram_username: user.username || null,
      target_telegram_first_name: user.first_name || null,
    });
    if (bind.error) {
      if (!this.expectedLinkConflict(bind.error.message)) {
        throw new ServiceUnavailableException('Unable to bind Telegram verification link');
      }
      const verified = await this.telegramAlreadyVerified(String(user.id));
      await this.sendMessage(chatId, verified
        ? 'Your Telegram account is already verified. Return to Nodenesia to continue.'
        : 'This verification link is invalid, expired, or already connected. Create a new link on Nodenesia.');
      return;
    }
    await this.checkAndComplete(tokenHash, user, chatId, this.eventId(update));
  }

  private async handleCallback(update: TelegramUpdate) {
    const callback = update.callback_query;
    const user = callback?.from;
    const chatId = callback?.message?.chat?.id;
    if (!callback?.id || callback.data !== 'verify_membership' || !user?.id || !chatId) return;
    await this.telegramRequest('answerCallbackQuery', { callback_query_id: callback.id });
    const token = await this.pendingToken(String(user.id));
    if (!token) {
      await this.sendMessage(chatId, 'No active verification request was found. Create a new link on Nodenesia.');
      return;
    }
    await this.checkAndComplete(token.token_hash, user, chatId, this.eventId(update));
  }

  private async handleChatMember(update: TelegramUpdate) {
    const membership = update.chat_member;
    if (String(membership?.chat?.id || '') !== this.groupId()) return;
    const member = membership?.new_chat_member;
    const user = member?.user;
    if (!user?.id || !member?.status) return;
    if (this.inactiveMemberStatus(member)) {
      const result = await this.db.client.rpc('mark_telegram_membership_inactive', {
        target_event_id: this.eventId(update),
        target_telegram_user_id: String(user.id),
        target_member_status: member.status,
      });
      if (result.error) throw new ServiceUnavailableException('Unable to update Telegram membership');
      return;
    }
    if (!this.activeMemberStatus(member)) return;
    const token = await this.pendingToken(String(user.id));
    if (!token) return;
    try {
      await this.complete(token.token_hash, user, this.normalizeMemberStatus(member!), this.eventId(update));
      await this.sendMessage(user.id, 'Verification complete. Return to Nodenesia to access your workspace and trial credit.');
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      await this.sendMessage(user.id, 'Your verification link expired. Return to Nodenesia and create a new link.');
    }
  }

  private async checkAndComplete(tokenHash: string, user: TelegramUser, chatId: number, eventId: string) {
    const member = await this.telegramRequest<TelegramChatMember>('getChatMember', {
      chat_id: this.groupId(),
      user_id: user.id,
    });
    if (!this.activeMemberStatus(member)) {
      await this.sendJoinPrompt(chatId);
      return;
    }
    try {
      await this.complete(tokenHash, user, this.normalizeMemberStatus(member), eventId);
      await this.sendMessage(chatId, 'Verification complete. Return to Nodenesia to access your workspace and trial credit.');
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      await this.sendMessage(chatId, 'Your verification link expired or is no longer valid. Return to Nodenesia and create a new link.');
    }
  }

  private async complete(tokenHash: string, user: TelegramUser, memberStatus: string, eventId: string) {
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ eventId, telegramUserId: String(user.id), memberStatus }))
      .digest('hex');
    const result = await this.db.client.rpc('complete_telegram_link_token', {
      target_token_hash: tokenHash,
      target_event_id: eventId,
      target_telegram_user_id: String(user.id),
      target_member_status: memberStatus,
      target_payload_hash: payloadHash,
    });
    if (result.error) this.throwDatabaseError(result.error.message, 'Telegram verification could not be completed');
    return result.data;
  }

  private async pendingToken(telegramUserId: string) {
    const result = await this.db.client
      .from('telegram_link_tokens')
      .select('token_hash')
      .eq('telegram_user_id', telegramUserId)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw new ServiceUnavailableException('Unable to load Telegram verification request');
    return result.data as { token_hash: string } | null;
  }

  private async telegramAlreadyVerified(telegramUserId: string) {
    const result = await this.db.client
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('telegram_user_id', telegramUserId)
      .eq('onboarding_status', 'verified');
    if (result.error) throw new ServiceUnavailableException('Unable to validate Telegram account');
    return (result.count || 0) > 0;
  }

  private async sendJoinPrompt(chatId: number) {
    await this.sendMessage(chatId, 'Join the Nodenesia community, then press Verify membership.', {
      inline_keyboard: [
        [{ text: 'Join Nodenesia', url: this.groupJoinUrl() }],
        [{ text: 'Verify membership', callback_data: 'verify_membership' }],
      ],
    });
  }

  private sendMessage(chatId: number, text: string, replyMarkup?: Record<string, unknown>) {
    return this.telegramRequest('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  private async telegramRequest<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.botToken()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new ServiceUnavailableException('Telegram API is unavailable');
    }
    const data = await response.json().catch(() => null) as TelegramApiResponse<T> | null;
    if (!response.ok || !data?.ok) throw new BadGatewayException(data?.description || `Telegram API ${method} failed`);
    return data.result as T;
  }

  private activeMemberStatus(member: TelegramChatMember | undefined) {
    return member?.status === 'member'
      || member?.status === 'administrator'
      || member?.status === 'creator'
      || (member?.status === 'restricted' && member.is_member === true);
  }

  private inactiveMemberStatus(member: TelegramChatMember | undefined): member is TelegramChatMember & { status: 'left' | 'kicked' } {
    return member?.status === 'left' || member?.status === 'kicked';
  }

  private normalizeMemberStatus(member: TelegramChatMember) {
    return member.status === 'administrator' || member.status === 'creator' ? member.status : 'member';
  }

  private parseUpdate(value: unknown): TelegramUpdate {
    if (!value || typeof value !== 'object') throw new ConflictException('Invalid Telegram update');
    const update = value as TelegramUpdate;
    if (!Number.isSafeInteger(update.update_id)) throw new ConflictException('Invalid Telegram update ID');
    return update;
  }

  private eventId(update: TelegramUpdate) {
    return `telegram-update:${update.update_id}`;
  }

  private verifyWebhookSecrets(pathSecret: string, headerSecret: string | undefined) {
    if (!this.secureEqual(pathSecret, this.requiredSecret('TELEGRAM_WEBHOOK_PATH_SECRET'))
      || !headerSecret
      || !this.secureEqual(headerSecret, this.requiredSecret('TELEGRAM_WEBHOOK_HEADER_SECRET'))) {
      throw new UnauthorizedException('Invalid Telegram webhook secret');
    }
  }

  private secureEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private linkTokenTtlSeconds() {
    const value = Number(this.config.get<string>('TELEGRAM_LINK_TOKEN_TTL_SECONDS') || 600);
    return Number.isFinite(value) ? Math.max(300, Math.min(Math.floor(value), 1800)) : 600;
  }

  private botToken() {
    const token = this.required('TELEGRAM_BOT_TOKEN');
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new ServiceUnavailableException('Telegram bot token is invalid');
    return token;
  }

  private botUsername() {
    const username = this.required('TELEGRAM_BOT_USERNAME').replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new ServiceUnavailableException('Telegram bot username is invalid');
    return username;
  }

  private groupId() {
    const groupId = this.required('TELEGRAM_GROUP_ID');
    if (!/^-\d{5,}$/.test(groupId)) throw new ServiceUnavailableException('Telegram group ID is invalid');
    return groupId;
  }

  private groupJoinUrl() {
    const raw = this.required('TELEGRAM_GROUP_JOIN_URL');
    let url: URL;
    try { url = new URL(raw); } catch { throw new ServiceUnavailableException('Telegram group join URL is invalid'); }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 't.me') throw new ServiceUnavailableException('Telegram group join URL is invalid');
    return url.toString();
  }

  private requiredSecret(name: string) {
    const value = this.required(name);
    if (value.length < 32) throw new ServiceUnavailableException(`${name} must contain at least 32 characters`);
    return value;
  }

  private required(name: string) {
    const value = this.config.get<string>(name)?.trim();
    if (!value) throw new ServiceUnavailableException(`${name} is not configured`);
    return value;
  }

  private expectedLinkConflict(message: string | undefined) {
    return /invalid|expired|already|another pending|does not own|not active|not found|only available/i.test(message || '');
  }

  private throwDatabaseError(message: string | undefined, fallback: string): never {
    if (this.expectedLinkConflict(message)) throw new ConflictException(message || fallback);
    throw new ServiceUnavailableException(fallback);
  }
}
