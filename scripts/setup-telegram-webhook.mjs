#!/usr/bin/env node

try { process.loadEnvFile('.env'); } catch {}

const required = name => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const token = required('TELEGRAM_BOT_TOKEN');
const configuredUsername = required('TELEGRAM_BOT_USERNAME').replace(/^@/, '');
const pathSecret = required('TELEGRAM_WEBHOOK_PATH_SECRET');
const headerSecret = required('TELEGRAM_WEBHOOK_HEADER_SECRET');
const baseUrl = new URL(required('TELEGRAM_WEBHOOK_BASE_URL'));

if (baseUrl.protocol !== 'https:') throw new Error('TELEGRAM_WEBHOOK_BASE_URL must use HTTPS');
if (baseUrl.username || baseUrl.password) throw new Error('TELEGRAM_WEBHOOK_BASE_URL must not contain credentials');
if (pathSecret.length < 32 || headerSecret.length < 32) throw new Error('Telegram webhook secrets must contain at least 32 characters');
if (!/^[A-Za-z0-9_-]+$/.test(pathSecret)) throw new Error('TELEGRAM_WEBHOOK_PATH_SECRET may contain only letters, digits, underscore and dash');
if (!/^[A-Za-z0-9_-]+$/.test(headerSecret)) throw new Error('TELEGRAM_WEBHOOK_HEADER_SECRET may contain only letters, digits, underscore and dash');

const telegram = async (method, body = {}) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.description || `Telegram ${method} failed`);
  return data.result;
};

const bot = await telegram('getMe');
if (String(bot.username || '').toLowerCase() !== configuredUsername.toLowerCase()) {
  throw new Error(`TELEGRAM_BOT_USERNAME does not match the bot token (expected ${bot.username})`);
}

const webhookUrl = new URL(`/api/telegram/webhook/${pathSecret}`, baseUrl).toString();
await telegram('setWebhook', {
  url: webhookUrl,
  secret_token: headerSecret,
  allowed_updates: ['message', 'chat_member', 'callback_query'],
});
const info = await telegram('getWebhookInfo');

process.stdout.write(`[telegram-webhook] Bot @${bot.username}\n`);
process.stdout.write(`[telegram-webhook] URL ${baseUrl.origin}/api/telegram/webhook/<redacted>\n`);
process.stdout.write(`[telegram-webhook] Pending updates ${info.pending_update_count || 0}\n`);
if (info.last_error_message) process.stdout.write(`[telegram-webhook] Last error: ${info.last_error_message}\n`);
