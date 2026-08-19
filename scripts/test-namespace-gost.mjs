#!/usr/bin/env node
// One-off Namespace instance + GOST test. It does not use the database.
// Ctrl+C (SIGINT) or SIGTERM destroys the temporary instance.
// Usage: NAMESPACE_TEST_TOKEN='…' npm run test:namespace-gost

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { promisify } from 'node:util';
import { createClients } from '@namespacelabs/cloud/node';
import {
  ContainerRequest_Network,
  ContainerRequest_WorkloadType,
  InstanceMetadata_Status,
} from '@namespacelabs/cloud';

try { process.loadEnvFile('.env'); } catch {}

const TEST_PORT = boundedInteger(process.env.NAMESPACE_TEST_PORT, 39995, 1024, 65535);
const region = randomRegion(process.env.NAMESPACE_REGION || 'us');
const placement = placementSelectors(process.env.NAMESPACE_PLACEMENT, region);
const gostVersion = requiredVersion(process.env.GOST_VERSION || '3.2.6');
const image = String(process.env.NAMESPACE_IMAGE || `gogost/gost:${gostVersion}`).trim();
const virtualCpu = boundedInteger(process.env.NAMESPACE_VCPU, 2, 1, 64);
const memoryMegabytes = boundedInteger(process.env.NAMESPACE_MEMORY_MB, 2048, 512, 262144);
const durationSeconds = boundedInteger(process.env.NAMESPACE_INSTANCE_DURATION_SECONDS, 3600, 300, 86400);
const readyTimeoutMs = boundedInteger(process.env.NAMESPACE_READY_TIMEOUT_MS, 180000, 30000, 600000);
const instanceReadyWaitMs = boundedInteger(process.env.NAMESPACE_INSTANCE_READY_WAIT_MS, 30000, 5000, readyTimeoutMs);
const cleanupTimeoutMs = boundedInteger(process.env.NAMESPACE_CLEANUP_TIMEOUT_MS, 90000, 10000, 300000);
const gostBinary = absoluteUnixPath('NAMESPACE_GOST_BINARY', process.env.NAMESPACE_GOST_BINARY || '/bin/gost');
const masterHost = hostname('NAMESPACE_GOST_MASTER_HOST', process.env.NAMESPACE_GOST_MASTER_HOST || process.env.BLAXEL_GOST_MASTER_HOST || process.env.GOST_MASTER_HOST);
const publicHost = hostname('GOST_PUBLIC_HOST', process.env.GOST_PUBLIC_HOST || masterHost);
const rendezvousPort = boundedInteger(process.env.NAMESPACE_GOST_RENDEZVOUS_PORT || process.env.BLAXEL_GOST_RENDEZVOUS_PORT, 443, 1, 65535);
const transport = tunnelTransport(process.env.NAMESPACE_GOST_TUNNEL_TRANSPORT || process.env.BLAXEL_GOST_TUNNEL_TRANSPORT || 'wss');
const wsPath = String(process.env.NAMESPACE_GOST_WS_PATH || process.env.BLAXEL_GOST_WS_PATH || '/ws').trim();
const tunnelUsername = required('NAMESPACE_GOST_TUNNEL_USERNAME', process.env.NAMESPACE_GOST_TUNNEL_USERNAME || process.env.BLAXEL_GOST_TUNNEL_USERNAME);
const tunnelPassword = required('NAMESPACE_GOST_TUNNEL_PASSWORD', process.env.NAMESPACE_GOST_TUNNEL_PASSWORD || process.env.BLAXEL_GOST_TUNNEL_PASSWORD);
const socksUsername = alphaNumeric(10);
const socksPassword = alphaNumeric(10);
const keepOnFailure = process.env.NAMESPACE_TEST_KEEP_ON_FAILURE === 'true';
const execFileAsync = promisify(execFile);

// Namespace's official no-SDK example supports NSC_TOKEN and NSC_TOKEN_FILE.
// Keep NAMESPACE_TEST_TOKEN as the explicit Nodenesia override, but accept the
// standard inputs too so this SDK script follows the same authentication flow.
const token = await loadNamespaceToken();
const clients = createClients(region, { token });

let instanceId = '';
let cleaning = false;

function fail(message) { throw new Error(message); }
function required(name, supplied = process.env[name]) {
  const value = String(supplied || '').trim();
  if (!value) fail(`${name} is required`);
  return value;
}
async function loadNamespaceToken() {
  const directToken = String(process.env.NAMESPACE_TEST_TOKEN || process.env.NSC_TOKEN || '').trim();
  if (directToken) return directToken;

  const tokenFile = String(process.env.NSC_TOKEN_FILE || '').trim();
  if (!tokenFile) {
    fail('Set NAMESPACE_TEST_TOKEN, NSC_TOKEN, or NSC_TOKEN_FILE containing Namespace bearer_token');
  }
  try {
    const parsed = JSON.parse(await readFile(tokenFile, 'utf8'));
    const bearerToken = String(parsed?.bearer_token || '').trim();
    if (bearerToken) return bearerToken;
  } catch (error) {
    fail(`Unable to load Namespace token file: ${error instanceof Error ? error.message : error}`);
  }
  fail('NSC_TOKEN_FILE does not contain a bearer_token');
}
function randomRegion(value) {
  const regions = [...new Set(String(value || '').split('|').map(entry => entry.trim()).filter(Boolean))];
  if (!regions.length || regions.some(region => !/^[a-z][a-z0-9-]{1,62}$/.test(region))) fail('NAMESPACE_REGION must contain one or more Namespace compute regions, for example us|eu');
  return regions[Math.floor(Math.random() * regions.length)];
}
function placementSelectors(value, fallbackRegion) {
  const entries = String(value || `continent:${fallbackRegion}`)
    .split('|')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (!entries.length) fail('NAMESPACE_PLACEMENT must contain one or more Namespace placement selectors');
  for (const entry of entries) {
    if (entry === 'any') continue;
    if (!/^(?:cell|site|continent):[a-z0-9-]{1,62}$/.test(entry)) {
      fail('NAMESPACE_PLACEMENT entries must be any, cell:<name>, site:<name>, or continent:<name>');
    }
  }
  return entries;
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
function absoluteUnixPath(name, value) {
  const path = String(value || '').trim();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) fail(`${name} must be an absolute Unix path`);
  return path;
}
function tunnelTransport(value) {
  if (!['tcp', 'ws', 'wss'].includes(value)) fail('NAMESPACE_GOST_TUNNEL_TRANSPORT must be tcp, ws, or wss');
  return value;
}
function alphaNumeric(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => alphabet[randomBytes(1)[0] % alphabet.length]).join('');
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function startupScript() {
  return `set -eu
if [ ! -x "\${GOST_BIN}" ]; then
  echo "GOST binary is not executable at \${GOST_BIN}; use gogost/gost:${gostVersion} or set NAMESPACE_GOST_BINARY" >&2
  exit 127
fi
"\${GOST_BIN}" -L="socks5://\${SOCKS_USER}:\${SOCKS_PASS}@127.0.0.1:\${LOCAL_PORT}\${SOCKS_QUERY}" >/tmp/gost-socks.log 2>&1 &
SOCKS_PID=$!
"\${GOST_BIN}" -L="rtcp://:\${BIND_PORT}/127.0.0.1:\${LOCAL_PORT}" -F="\${TUNNEL_SCHEME}://\${TUNNEL_USER}:\${TUNNEL_PASS}@\${MASTER_HOST}:\${RENDEZVOUS_PORT}\${TUNNEL_QUERY}" >/tmp/gost-tunnel.log 2>&1 &
TUNNEL_PID=$!
trap 'kill "\${SOCKS_PID}" "\${TUNNEL_PID}" 2>/dev/null || true' EXIT INT TERM
wait "\${SOCKS_PID}" "\${TUNNEL_PID}"`;
}

function containerEnvironment() {
  const tunnelQuery = transport === 'wss'
    ? `?path=${encodeURIComponent(wsPath)}&secure=true&serverName=${encodeURIComponent(masterHost)}`
    : transport === 'ws' ? `?path=${encodeURIComponent(wsPath)}` : '';
  return {
    SOCKS_USER: encodeURIComponent(socksUsername),
    SOCKS_PASS: encodeURIComponent(socksPassword),
    SOCKS_QUERY: gostQuery(),
    LOCAL_PORT: '1080',
    BIND_PORT: String(TEST_PORT),
    TUNNEL_SCHEME: transport === 'tcp' ? 'socks5' : `socks5+${transport}`,
    TUNNEL_USER: encodeURIComponent(tunnelUsername),
    TUNNEL_PASS: encodeURIComponent(tunnelPassword),
    MASTER_HOST: masterHost,
    RENDEZVOUS_PORT: String(rendezvousPort),
    TUNNEL_QUERY: tunnelQuery,
    GOST_BIN: gostBinary,
  };
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
  while (Date.now() < deadline) {
    if (await socksAuth()) return;
    await wait(1000);
  }
  fail(`SOCKS5 endpoint ${publicHost}:${TEST_PORT} did not become reachable`);
}

async function observeNamespaceInstanceReadiness() {
  try {
    // WaitInstanceSync is useful as a control-plane diagnostic, but is not the
    // readiness source for this test: the Ubuntu startup script still needs to
    // install and start GOST after the instance scheduler reports readiness.
    await clients.compute.waitInstanceSync(
      { instanceId },
      { signal: AbortSignal.timeout(instanceReadyWaitMs) },
    );
    process.stdout.write('[namespace-test] Namespace instance reports ready.\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`[namespace-test] Instance readiness is still pending after ${instanceReadyWaitMs}ms; continuing SOCKS5 checks. (${message})\n`);
  }
}

async function reportProxyEgress() {
  const proxy = `socks5h://${encodeURIComponent(socksUsername)}:${encodeURIComponent(socksPassword)}@${publicHost}:${TEST_PORT}`;
  try {
    const { stdout } = await execFileAsync('curl', ['--silent', '--show-error', '--fail', '--max-time', '20', '--proxy', proxy, 'https://api.ipify.org']);
    const address = String(stdout).trim();
    process.stdout.write(net.isIP(address) ? `[namespace-test] Proxy egress IP (via SOCKS5): ${address}\n` : '[namespace-test] Proxy egress IP: unavailable (unexpected response through SOCKS5)\n');
  } catch { process.stdout.write('[namespace-test] Proxy egress IP: unavailable (curl through SOCKS5 failed)\n'); }
}

async function diagnose() {
  if (!instanceId) return;
  try {
    const lines = [];
    for await (const block of clients.observability.streamInstanceLogs({ instanceId, follow: false })) {
      for (const line of block.lines || []) lines.push(line.content);
    }
    if (lines.length) process.stderr.write(`\n[namespace-test] Namespace logs:\n${lines.join('\n').slice(-4000)}\n`);
  } catch (error) {
    process.stderr.write(`[namespace-test] Could not retrieve instance logs: ${error instanceof Error ? error.message : error}\n`);
  }
}

async function destroyAndConfirmInstance() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      process.stdout.write(`[namespace-test] Requesting destruction (attempt ${attempt}/3)…\n`);
      await clients.compute.destroyInstance(
        { instanceId, reason: 'Nodenesia one-off GOST test cleanup' },
        { signal: AbortSignal.timeout(30000) },
      );
      return await waitForInstanceRemoval();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(1500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Namespace destroy request failed'));
}

async function waitForInstanceRemoval() {
  const deadline = Date.now() + cleanupTimeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    try {
      const current = await clients.compute.describeInstance(
        { instanceId },
        { signal: AbortSignal.timeout(10000) },
      );
      const statusCode = current.metadata?.status;
      if (isTerminalInstanceStatus(statusCode)) {
        process.stdout.write(`[namespace-test] Namespace confirmed terminal instance status: ${instanceStatusName(statusCode)}.\n`);
        return true;
      }
      const status = instanceStatusName(statusCode);
      if (status !== lastStatus) {
        process.stdout.write(`[namespace-test] Namespace instance status: ${status}\n`);
        lastStatus = status;
      }
    } catch (error) {
      if (isNotFound(error)) {
        process.stdout.write('[namespace-test] Namespace confirmed the instance is no longer available.\n');
        return true;
      }
      process.stderr.write(`[namespace-test] Could not poll destruction status: ${error instanceof Error ? error.message : error}\n`);
    }
    await wait(2000);
  }
  process.stdout.write(`[namespace-test] Destruction request was accepted; Namespace is still finalizing after ${cleanupTimeoutMs}ms.\n`);
  return false;
}

function isNotFound(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return code === 5 || code === 'not_found' || code === 'NOT_FOUND';
}

function isTerminalInstanceStatus(status) {
  return status === InstanceMetadata_Status.DESTROYED || status === InstanceMetadata_Status.ERROR;
}

function instanceStatusName(status) {
  return InstanceMetadata_Status[status] || String(status ?? 'STATUS_UNKNOWN');
}

async function cleanup(exitCode = 0) {
  if (cleaning) {
    process.stdout.write('[namespace-test] Cleanup is already in progress; waiting for Namespace.\n');
    return;
  }
  cleaning = true;
  if (instanceId) {
    process.stdout.write(`\n[namespace-test] Destroying instance ${instanceId}…\n`);
    try { await destroyAndConfirmInstance(); }
    catch (error) { process.stderr.write(`[namespace-test] Cleanup failed: ${error instanceof Error ? error.message : error}\n`); exitCode = 1; }
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => void cleanup(0));
process.on('SIGTERM', () => void cleanup(0));
process.once('uncaughtException', error => { process.stderr.write(`${error.stack || error}\n`); void cleanup(1); });
process.once('unhandledRejection', error => { process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`); void cleanup(1); });

try {
  // An expired/invalid 24-hour development token fails before any billable
  // resource is created.
  try {
    await clients.compute.listInstances({ maxEntries: 1n });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Namespace preflight requires instance:list permission: ${message}`);
  }
  const deadline = new Date(Date.now() + durationSeconds * 1000);
  process.stdout.write(`[namespace-test] Creating ${virtualCpu} vCPU / ${memoryMegabytes} MB Linux instance in ${region} with placement ${placement.join(' > ')} (deadline ${durationSeconds}s)…\n`);
  const created = await clients.compute.createInstance({
    // `region` and `placement` are mutually exclusive in Namespace. Placement
    // is more expressive and prevents the platform from choosing global
    // capacity outside the requested continent/site.
    placement,
    shape: { virtualCpu, memoryMegabytes, machineArch: 'amd64', os: 'linux' },
    documentedPurpose: 'Nodenesia one-off GOST SOCKS5 test',
    deadline: { seconds: BigInt(Math.floor(deadline.getTime() / 1000)), nanos: 0 },
    labels: [{ name: 'managed-by', value: 'nodenesia-gost-test' }],
    containers: [{
      name: 'nodenesia-gost',
      imageRef: image,
      entrypoint: ['/bin/sh', '-lc'],
      args: [startupScript()],
      environment: containerEnvironment(),
      // BRIDGE is the documented default network. SERVICE makes a terminated
      // GOST process fail the instance instead of appearing healthy.
      network: ContainerRequest_Network.BRIDGE,
      workloadType: ContainerRequest_WorkloadType.SERVICE,
    }],
  });
  instanceId = String(created.metadata?.instanceId || '');
  if (!instanceId) fail('Namespace did not return an instance ID');
  process.stdout.write(`[namespace-test] Instance created: ${instanceId}\n`);
  process.stdout.write('[namespace-test] Starting SOCKS5 checks; Namespace readiness is monitored in parallel…\n');
  void observeNamespaceInstanceReadiness();
  await waitForProxy();
  process.stdout.write(`\n[namespace-test] SOCKS5 ready: socks5://${socksUsername}:${socksPassword}@${publicHost}:${TEST_PORT}\n`);
  await reportProxyEgress();
  process.stdout.write('[namespace-test] Keeping instance alive; press Ctrl+C to destroy it. The Namespace deadline is the safety cleanup.\n');
  await new Promise(() => { setInterval(() => {}, 60000); });
} catch (error) {
  process.stderr.write(`[namespace-test] ${error instanceof Error ? error.message : error}\n`);
  await diagnose();
  if (keepOnFailure && instanceId) {
    process.stderr.write(`[namespace-test] Keeping ${instanceId} for inspection; it will still end at its Namespace deadline.\n`);
    process.exit(1);
  }
  await cleanup(1);
}

function gostQuery() {
  const params = [];
  if (process.env.GOST_NODE_BANDWIDTH_IN) params.push(`limiter.in=${encodeURIComponent(process.env.GOST_NODE_BANDWIDTH_IN)}`);
  if (process.env.GOST_NODE_BANDWIDTH_OUT) params.push(`limiter.out=${encodeURIComponent(process.env.GOST_NODE_BANDWIDTH_OUT)}`);
  const maxConnections = Number(process.env.GOST_NODE_MAX_CONNECTIONS || 0);
  if (Number.isFinite(maxConnections) && maxConnections > 0) params.push(`climiter=${Math.floor(maxConnections)}`);
  return params.length ? `?${params.join('&')}` : '';
}
