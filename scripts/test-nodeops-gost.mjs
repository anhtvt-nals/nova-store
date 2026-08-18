#!/usr/bin/env node
// One-off NodeOps CreateOS sandbox + GOST test. It does not touch the database.
// On success it destroys the sandbox. Set NODEOPS_TEST_KEEP_ALIVE=true to keep
// the proxy available until Ctrl+C; SIGINT/SIGTERM always destroys the sandbox.
// Usage: NODEOPS_TEST_API_KEY='…' npm run test:nodeops-gost

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { createClient } from '@nodeops-createos/sandbox';

try { process.loadEnvFile('.env'); } catch {}

const TEST_PORT = boundedInteger(process.env.NODEOPS_TEST_PORT, 39996, 1024, 65535);
const apiKey = required('NODEOPS_TEST_API_KEY');
const baseUrl = String(process.env.NODEOPS_SANDBOX_BASE_URL || 'https://api.sb.createos.sh').replace(/\/$/, '');
const shape = String(process.env.NODEOPS_SANDBOX_SHAPE || 's-1vcpu-1gb').trim();
const rootfs = String(process.env.NODEOPS_SANDBOX_ROOTFS || 'devbox:1').trim();
const readyTimeoutMs = boundedInteger(process.env.NODEOPS_READY_TIMEOUT_MS, 180000, 30000, 600000);
const gostVersion = requiredVersion(process.env.GOST_VERSION || '3.2.6');
const masterHost = hostname('NODEOPS_GOST_MASTER_HOST', process.env.NODEOPS_GOST_MASTER_HOST || process.env.BLAXEL_GOST_MASTER_HOST || process.env.GOST_MASTER_HOST);
const publicHost = hostname('GOST_PUBLIC_HOST', process.env.GOST_PUBLIC_HOST || masterHost);
const rendezvousPort = boundedInteger(process.env.NODEOPS_GOST_RENDEZVOUS_PORT || process.env.BLAXEL_GOST_RENDEZVOUS_PORT, 443, 1, 65535);
const transport = tunnelTransport(process.env.NODEOPS_GOST_TUNNEL_TRANSPORT || process.env.BLAXEL_GOST_TUNNEL_TRANSPORT || 'wss');
const wsPath = String(process.env.NODEOPS_GOST_WS_PATH || process.env.BLAXEL_GOST_WS_PATH || '/ws').trim();
const tunnelUsername = required('NODEOPS_GOST_TUNNEL_USERNAME', process.env.NODEOPS_GOST_TUNNEL_USERNAME || process.env.BLAXEL_GOST_TUNNEL_USERNAME);
const tunnelPassword = required('NODEOPS_GOST_TUNNEL_PASSWORD', process.env.NODEOPS_GOST_TUNNEL_PASSWORD || process.env.BLAXEL_GOST_TUNNEL_PASSWORD);
const socksUsername = alphaNumeric(10);
const socksPassword = alphaNumeric(10);
const keepAlive = process.env.NODEOPS_TEST_KEEP_ALIVE === 'true';
const keepOnFailure = process.env.NODEOPS_TEST_KEEP_ON_FAILURE === 'true';
const execFileAsync = promisify(execFile);
const client = createClient({ apiKey, baseUrl, timeoutMs: readyTimeoutMs });

let sandbox;
let cleaning = false;

function fail(message) { throw new Error(message); }
function required(name, supplied = process.env[name]) {
  const value = String(supplied || '').trim();
  if (!value) fail(`${name} is required`);
  return value;
}
function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value || fallback);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}
function requiredVersion(value) {
  if (!/^3\.\d+\.\d+$/.test(value)) fail('GOST_VERSION must be a stable GOST v3 version');
  return value;
}
function hostname(name, value) {
  const host = String(value || '').trim();
  if (!host || /[\s/@?&#'"\\]/.test(host) || !/^[A-Za-z0-9.:-]+$/.test(host)) fail(`${name} must be a hostname or IP address`);
  return host;
}
function tunnelTransport(value) {
  if (!['tcp', 'ws', 'wss'].includes(value)) fail('NODEOPS_GOST_TUNNEL_TRANSPORT must be tcp, ws, or wss');
  return value;
}
function alphaNumeric(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => alphabet[randomBytes(1)[0] % alphabet.length]).join('');
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function run(label, script, timeoutMs = 120000) {
  try { return await sandbox.sh(script, { label, timeoutMs }); }
  catch (error) { throw new Error(`NodeOps sandbox ${label} failed: ${error instanceof Error ? error.message : error}`); }
}

function socksAuth(timeoutMs = 5000) {
  return new Promise(resolve => {
    let socket; let stage = 'greeting'; let buffer = Buffer.alloc(0); let settled = false;
    const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); socket?.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try { socket = net.createConnection({ host: publicHost, port: TEST_PORT }); } catch { finish(false); return; }
    socket.on('error', () => finish(false)); socket.on('close', () => finish(false));
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x02])));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting' && buffer.length >= 2) {
        if (buffer[0] !== 0x05 || buffer[1] !== 0x02) return finish(false);
        buffer = buffer.subarray(2); stage = 'auth';
        const user = Buffer.from(socksUsername); const pass = Buffer.from(socksPassword);
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      }
      if (stage === 'auth' && buffer.length >= 2) finish(buffer[0] === 0x01 && buffer[1] === 0x00);
    });
  });
}

async function waitForProxy() {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) { if (await socksAuth()) return; await wait(1000); }
  fail(`SOCKS5 endpoint ${publicHost}:${TEST_PORT} did not become reachable`);
}

async function reportProxyEgress() {
  const proxy = `socks5h://${encodeURIComponent(socksUsername)}:${encodeURIComponent(socksPassword)}@${publicHost}:${TEST_PORT}`;
  try {
    const { stdout } = await execFileAsync('curl', ['--silent', '--show-error', '--fail', '--max-time', '20', '--proxy', proxy, 'https://api.ipify.org']);
    const address = String(stdout).trim();
    process.stdout.write(net.isIP(address) ? `[nodeops-test] Proxy egress IP (via SOCKS5): ${address}\n` : '[nodeops-test] Proxy egress IP: unavailable (unexpected response through SOCKS5)\n');
  } catch { process.stdout.write('[nodeops-test] Proxy egress IP: unavailable (curl through SOCKS5 failed)\n'); }
}

async function diagnose() {
  if (!sandbox) return;
  try {
    const { result } = await sandbox.sh('echo "--- gost-socks ---"; tail -n 80 /tmp/gost-socks.log 2>&1 || true; echo "--- gost-tunnel ---"; tail -n 80 /tmp/gost-tunnel.log 2>&1 || true', { label: 'GOST diagnostics', timeoutMs: 30000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (output) process.stderr.write(`\n[nodeops-test] GOST diagnostics:\n${output.slice(-4000)}\n`);
  } catch (error) { process.stderr.write(`[nodeops-test] Could not retrieve GOST diagnostics: ${error instanceof Error ? error.message : error}\n`); }
}

async function cleanup(exitCode = 0) {
  if (cleaning) return;
  cleaning = true;
  if (sandbox) {
    process.stdout.write(`\n[nodeops-test] Destroying sandbox ${sandbox.id}…\n`);
    try { await sandbox.destroy({ timeoutMs: 60000 }); await sandbox.waitUntilDestroyed({ timeoutMs: readyTimeoutMs }); }
    catch (error) { process.stderr.write(`[nodeops-test] Cleanup failed: ${error instanceof Error ? error.message : error}\n`); exitCode = 1; }
  }
  process.exit(exitCode);
}

process.once('SIGINT', () => void cleanup(0));
process.once('SIGTERM', () => void cleanup(0));
process.once('uncaughtException', error => { process.stderr.write(`${error.stack || error}\n`); void cleanup(1); });
process.once('unhandledRejection', error => { process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`); void cleanup(1); });

try {
  const name = `nodenesia-gost-test-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  process.stdout.write(`[nodeops-test] Creating sandbox ${name} (${shape}, ${rootfs})…\n`);
  sandbox = await client.createSandbox({ name, shape, rootfs, egress: ['*'] }, { timeoutMs: readyTimeoutMs });
  process.stdout.write(`[nodeops-test] Sandbox running: ${sandbox.id}\n`);
  const install = `set -eu
if ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates curl tar; else apk add --no-cache ca-certificates curl tar; fi
fi
curl -fsSL -o /tmp/gost.tar.gz ${shellQuote(`https://github.com/go-gost/gost/releases/download/v${gostVersion}/gost_${gostVersion}_linux_amd64.tar.gz`)}
tar -xzf /tmp/gost.tar.gz -C /tmp gost
chmod +x /tmp/gost
/tmp/gost -V`;
  await run('install-gost', install, 180000);
  const socksQuery = gostQuery();
  await run('start-gost-socks', `nohup /tmp/gost -L=${shellQuote(`socks5://${encodeURIComponent(socksUsername)}:${encodeURIComponent(socksPassword)}@127.0.0.1:1080${socksQuery}`)} >/tmp/gost-socks.log 2>&1 < /dev/null &`, 30000);
  const scheme = transport === 'tcp' ? 'socks5' : `socks5+${transport}`;
  const tunnelQuery = transport === 'wss' ? `?path=${encodeURIComponent(wsPath)}&secure=true&serverName=${encodeURIComponent(masterHost)}` : transport === 'ws' ? `?path=${encodeURIComponent(wsPath)}` : '';
  const upstream = `${scheme}://${encodeURIComponent(tunnelUsername)}:${encodeURIComponent(tunnelPassword)}@${masterHost}:${rendezvousPort}${tunnelQuery}`;
  await run('start-gost-tunnel', `nohup /tmp/gost -L=${shellQuote(`rtcp://:${TEST_PORT}/127.0.0.1:1080`)} -F=${shellQuote(upstream)} >/tmp/gost-tunnel.log 2>&1 < /dev/null &`, 30000);
  await waitForProxy();
  const proxyUrl = `socks5://${socksUsername}:${socksPassword}@${publicHost}:${TEST_PORT}`;
  process.stdout.write(`\n[nodeops-test] SOCKS5 ready: ${proxyUrl}\n`);
  await reportProxyEgress();
  if (keepAlive) {
    process.stdout.write('[nodeops-test] Keeping sandbox alive; press Ctrl+C to destroy it.\n');
    await new Promise(() => { setInterval(() => {}, 60000); });
  }
  process.stdout.write('[nodeops-test] Test completed; cleaning sandbox…\n');
  await cleanup(0);
} catch (error) {
  process.stderr.write(`[nodeops-test] ${error instanceof Error ? error.message : error}\n`);
  await diagnose();
  if (keepOnFailure && sandbox) { process.stderr.write(`[nodeops-test] Keeping ${sandbox.id} for inspection; destroy it manually in CreateOS.\n`); process.exit(1); }
  await cleanup(1);
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`; }
function gostQuery() {
  const params = [];
  if (process.env.GOST_NODE_BANDWIDTH_IN) params.push(`limiter.in=${encodeURIComponent(process.env.GOST_NODE_BANDWIDTH_IN)}`);
  if (process.env.GOST_NODE_BANDWIDTH_OUT) params.push(`limiter.out=${encodeURIComponent(process.env.GOST_NODE_BANDWIDTH_OUT)}`);
  const maxConnections = Number(process.env.GOST_NODE_MAX_CONNECTIONS || 0);
  if (Number.isFinite(maxConnections) && maxConnections > 0) params.push(`climiter=${Math.floor(maxConnections)}`);
  return params.length ? `?${params.join('&')}` : '';
}
