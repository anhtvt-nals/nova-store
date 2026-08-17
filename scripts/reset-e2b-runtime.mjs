#!/usr/bin/env node

// Destructive recovery tool for E2B account-capacity incidents. It deletes
// every sandbox visible to every configured E2B credential, marks stale
// runtime rows stopped, releases E2B leases, sets each E2B key to a safe
// per-key limit, and queues active E2B nodes for replacement.

import { createDecipheriv, createHash } from 'node:crypto';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { Sandbox } from 'e2b';

try { process.loadEnvFile('.env'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }

const execute = process.argv.includes('--execute');
const confirmation = process.argv.find(argument => argument.startsWith('--confirm='))?.slice('--confirm='.length) || '';
const limitArgument = process.argv.find(argument => argument.startsWith('--per-key-limit='))?.slice('--per-key-limit='.length) || '10';
const perKeyLimit = Number(limitArgument);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const encryptionKey = process.env.PROVIDER_SECRET_ENCRYPTION_KEY;

function fail(message) { console.error(`[reset-e2b-runtime] ERROR: ${message}`); process.exit(1); }
if (!supabaseUrl || !supabaseKey || !encryptionKey) fail('SUPABASE_URL, SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY), and PROVIDER_SECRET_ENCRYPTION_KEY are required.');
if (!Number.isInteger(perKeyLimit) || perKeyLimit < 1 || perKeyLimit > 100) fail('--per-key-limit must be an integer between 1 and 100.');

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
const project = new URL(supabaseUrl).hostname.split('.')[0];
const requiredConfirmation = `RESET_ALL_E2B_RUNTIME:${project}`;

function unwrap(result, message) {
  if (result.error) fail(`${message}: ${result.error.message}`);
  return result.data || [];
}

function decryptKey(row) {
  try {
    const key = createHash('sha256').update(encryptionKey).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.secret_iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.secret_tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.secret_ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    fail(`Unable to decrypt E2B credential #${row.id}. Check PROVIDER_SECRET_ENCRYPTION_KEY.`);
  }
}

async function listSandboxes(apiKey) {
  const paginator = Sandbox.list({ apiKey, limit: 100 });
  const sandboxes = [];
  while (paginator.hasNext) sandboxes.push(...await paginator.nextItems({ apiKey, requestTimeoutMs: 30_000 }));
  return sandboxes;
}

async function deleteSandboxes(apiKey, label) {
  const sandboxes = await listSandboxes(apiKey);
  console.log(`[reset-e2b-runtime] E2B key ${label}: ${sandboxes.length} sandbox(es) found.`);
  for (const sandbox of sandboxes) {
    await Sandbox.kill(sandbox.sandboxId, { apiKey, requestTimeoutMs: 30_000 });
    console.log(`[reset-e2b-runtime] killed ${sandbox.sandboxId}`);
  }
  const remaining = await listSandboxes(apiKey);
  if (remaining.length) fail(`E2B key ${label} still has ${remaining.length} sandbox(es); no database state was changed.`);
  return sandboxes.length;
}

const providers = unwrap(await supabase.from('proxy_providers').select('id,name,code,metadata').eq('status', 'active'), 'Unable to load providers');
const e2bProviders = providers.filter(provider => String(provider.metadata?.driver || provider.code) === 'e2b');
if (!e2bProviders.length) fail('No active E2B provider is configured.');
const providerIds = e2bProviders.map(provider => provider.id);
const keys = unwrap(await supabase.from('provider_api_keys').select('id,provider_id,label,status,secret_ciphertext,secret_iv,secret_tag').in('provider_id', providerIds), 'Unable to load E2B API keys');
if (!keys.length) fail('No E2B API key is configured.');

const nodes = unwrap(await supabase.from('proxy_nodes').select('id,order_id').in('provider_id', providerIds), 'Unable to load E2B nodes');
const orderIds = [...new Set(nodes.map(node => node.order_id))];
const orders = orderIds.length ? unwrap(await supabase.from('orders').select('id,status,expires_at').in('id', orderIds), 'Unable to load E2B orders') : [];
const activeOrders = new Set(orders.filter(order => order.status === 'active' && order.expires_at && new Date(order.expires_at) > new Date()).map(order => order.id));
const activeNodes = nodes.filter(node => activeOrders.has(node.order_id));

console.table(keys.map(key => ({ keyId: key.id, label: key.label, status: key.status, providerId: key.provider_id, targetLimit: perKeyLimit })));
console.log(`[reset-e2b-runtime] ${activeNodes.length} active E2B node(s) will be queued for replacement.`);
if (!execute) {
  console.log('[reset-e2b-runtime] Dry run only; no sandbox or database record was changed.');
  console.log('[reset-e2b-runtime] Stop nodenesia-api first, apply the capacity migrations, then run:');
  console.log(`npm run reset:e2b-runtime -- --execute --confirm='${requiredConfirmation}' --per-key-limit=${perKeyLimit}`);
  process.exit(0);
}
if (confirmation !== requiredConfirmation) fail(`Confirmation mismatch. Expected --confirm='${requiredConfirmation}'`);

const seen = new Set();
let deleted = 0;
for (const key of keys) {
  const apiKey = decryptKey(key);
  const fingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
  if (seen.has(fingerprint)) continue;
  seen.add(fingerprint);
  deleted += await deleteSandboxes(apiKey, `#${key.id} (${fingerprint})`);
}

const now = new Date().toISOString();
for (const key of keys.filter(key => key.status === 'active')) {
  unwrap(await supabase.from('provider_api_keys').update({ max_sandboxes: perKeyLimit }).eq('id', key.id), `Unable to set limit for E2B key #${key.id}`);
}
unwrap(await supabase.from('provider_capacity_leases').update({ status: 'released', released_at: now }).in('provider_id', providerIds).is('released_at', null), 'Unable to release E2B capacity leases');
unwrap(await supabase.from('proxy_node_instances').update({ status: 'stopped', stopped_at: now, last_heartbeat_at: now }).in('provider_id', providerIds).in('status', ['provisioning', 'running', 'stopping']), 'Unable to stop E2B instance records');

if (activeNodes.length) {
  const nodeIds = activeNodes.map(node => node.id);
  unwrap(await supabase.from('proxy_nodes').update({ current_instance_id: null, status: 'rotating', error_code: null, error_message: null, last_status_change_at: now }).in('id', nodeIds), 'Unable to reset E2B nodes');
  const jobs = nodeIds.map(nodeId => ({ node_id: nodeId, action: 'replace', status: 'queued', attempts: 0, max_attempts: 5, run_after: now, locked_by: null, locked_until: null, last_error: null, updated_at: now }));
  unwrap(await supabase.from('proxy_provisioning_jobs').upsert(jobs, { onConflict: 'node_id,action' }), 'Unable to queue E2B replacements');
}

console.log(`[reset-e2b-runtime] Complete: deleted ${deleted} E2B sandbox(es), set ${keys.filter(key => key.status === 'active').length} active key limit(s) to ${perKeyLimit}, and queued ${activeNodes.length} replacement(s).`);
console.log('[reset-e2b-runtime] Start nodenesia-api. It will provision replacements using the renewed per-key limits.');
