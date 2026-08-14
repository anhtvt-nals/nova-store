#!/usr/bin/env node

import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

try {
  process.loadEnvFile('.env');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const execute = process.argv.includes('--execute');
const allowActiveRuntime = process.argv.includes('--allow-active-runtime');
const confirmArgument = process.argv.find(argument => argument.startsWith('--confirm='));
const suppliedConfirmation = confirmArgument?.slice('--confirm='.length) || '';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  fail('SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required.');
}

let target;
try {
  target = new URL(supabaseUrl);
} catch {
  fail('SUPABASE_URL is not a valid URL.');
}

if (target.protocol !== 'https:' && target.hostname !== 'localhost' && target.hostname !== '127.0.0.1') {
  fail('SUPABASE_URL must use HTTPS unless it points to localhost.');
}

const projectRef = target.hostname.split('.')[0] || target.hostname;
const confirmation = `DELETE_ALL_ORDERS:${projectRef}`;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

function fail(message) {
  console.error(`[clean-orders] ERROR: ${message}`);
  process.exit(1);
}

async function countRows(table, configure = query => query) {
  const query = supabase.from(table).select('*', { count: 'exact', head: true });
  const { count, error } = await configure(query);
  if (error) fail(`Unable to count ${table}: ${error.message}`);
  return count || 0;
}

async function loadSummary() {
  const orderStatuses = ['pending', 'provisioning', 'active', 'provisioning_failed', 'expired', 'rejected', 'cancelled'];
  const [orders, nodes, jobs, instances, leases, orderLogs, activeJobs, activeInstances, ...statusCounts] = await Promise.all([
    countRows('orders'),
    countRows('proxy_nodes'),
    countRows('proxy_provisioning_jobs'),
    countRows('proxy_node_instances'),
    countRows('provider_capacity_leases'),
    countRows('activity_logs', query => query.eq('entity_type', 'order')),
    countRows('proxy_provisioning_jobs', query => query.in('status', ['queued', 'running', 'retry'])),
    countRows('proxy_node_instances', query => query.in('status', ['provisioning', 'running', 'stopping'])),
    ...orderStatuses.map(status => countRows('orders', query => query.eq('status', status))),
  ]);

  return {
    orders,
    nodes,
    jobs,
    instances,
    leases,
    orderLogs,
    activeJobs,
    activeInstances,
    statuses: Object.fromEntries(orderStatuses.map((status, index) => [status, statusCounts[index]])),
  };
}

function printSummary(summary) {
  console.log(`[clean-orders] Target: ${target.origin} (project: ${projectRef})`);
  console.table({
    orders: summary.orders,
    proxy_nodes: summary.nodes,
    provisioning_jobs: summary.jobs,
    node_instances: summary.instances,
    capacity_leases: summary.leases,
    order_activity_logs: summary.orderLogs,
    active_provisioning_jobs: summary.activeJobs,
    active_provider_instances: summary.activeInstances,
  });
  console.log('[clean-orders] Order statuses:');
  console.table(summary.statuses);
}

const before = await loadSummary();
printSummary(before);

if (!execute) {
  console.log('[clean-orders] Dry run only; nothing was deleted.');
  console.log(`[clean-orders] Stop the Nest API, then execute with:`);
  console.log(`npm run clean:test-orders -- --execute --confirm='${confirmation}'`);
  process.exit(0);
}

if (suppliedConfirmation !== confirmation) {
  fail(`Confirmation mismatch. Expected --confirm='${confirmation}'`);
}

if ((before.activeJobs > 0 || before.activeInstances > 0) && !allowActiveRuntime) {
  fail(
    `Found ${before.activeJobs} active provisioning job(s) and ${before.activeInstances} active provider instance(s). `
    + 'Stop the API and terminate those provider instances first. If they are intentionally disposable, rerun with --allow-active-runtime.',
  );
}

if (before.orders === 0) {
  console.log('[clean-orders] No orders found; nothing to delete.');
  process.exit(0);
}

console.log('[clean-orders] Deleting all orders. Related proxy rows will be removed by foreign-key cascades.');
const deletedOrders = await supabase.from('orders').delete().gte('id', 0);
if (deletedOrders.error) fail(`Unable to delete orders: ${deletedOrders.error.message}`);

const deletedLogs = await supabase.from('activity_logs').delete().eq('entity_type', 'order');
if (deletedLogs.error) fail(`Orders were deleted, but order activity log cleanup failed: ${deletedLogs.error.message}`);

const after = await loadSummary();
if (after.orders || after.nodes || after.jobs || after.instances || after.leases || after.orderLogs) {
  printSummary(after);
  fail('Cleanup finished with related rows still present. Review the database constraints before retrying.');
}

console.log('[clean-orders] Cleanup complete. Orders and related database records are now empty.');
console.log('[clean-orders] Identity sequences were intentionally not reset.');
