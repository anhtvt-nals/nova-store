#!/usr/bin/env node
// Creates one temporary Blaxel sandbox and exposes a test SOCKS5 proxy at
// GOST_PUBLIC_HOST:39999. Ctrl+C (SIGINT) or SIGTERM deletes the sandbox.
// Usage: BLAXEL_TEST_KEY='workspace|api-key' npm run test:blaxel-gost

import { randomBytes } from 'node:crypto';
import net from 'node:net';

try { process.loadEnvFile('.env'); } catch {}

const TEST_PORT = 39999;
const apiBaseUrl = String(process.env.BLAXEL_API_BASE_URL || 'https://api.blaxel.ai/v0').replace(/\/$/, '');
const apiVersion = String(process.env.BLAXEL_API_VERSION || '2026-04-16');
const image = String(process.env.BLAXEL_IMAGE || 'blaxel/base-image:latest');
const region = String(process.env.BLAXEL_REGION || 'us-pdx-1');
const memory = boundedInteger(process.env.BLAXEL_SANDBOX_MEMORY_MB, 1024, 512, 65536);
const readyTimeoutMs = boundedInteger(process.env.BLAXEL_READY_TIMEOUT_MS, 180000, 30000, 600000);
const gostVersion = requiredVersion('GOST_VERSION', process.env.GOST_VERSION || '3.2.6');
const masterHost = required('GOST_MASTER_HOST');
const publicHost = String(process.env.GOST_PUBLIC_HOST || masterHost).trim();
const rendezvousPort = boundedInteger(process.env.GOST_RENDEZVOUS_PORT, 28443, 1, 65535);
const localPort = boundedInteger(process.env.GOST_LOCAL_SOCKS_PORT, 1080, 1, 65535);
const tunnelTransport = ['tcp', 'ws', 'wss'].includes(process.env.GOST_TUNNEL_TRANSPORT || 'tcp') ? (process.env.GOST_TUNNEL_TRANSPORT || 'tcp') : fail('GOST_TUNNEL_TRANSPORT must be tcp, ws, or wss');
const tunnelUsername = required('GOST_TUNNEL_USERNAME');
const tunnelPassword = required('GOST_TUNNEL_PASSWORD');
const { workspace, apiKey } = parseKey(process.env.BLAXEL_TEST_KEY || process.env.BLAXEL_PROVIDER_KEY || '');
const socksUsername = String(process.env.BLAXEL_TEST_SOCKS_USERNAME || alphaNumeric(10));
const socksPassword = String(process.env.BLAXEL_TEST_SOCKS_PASSWORD || alphaNumeric(10));

let sandboxName = '';
let sandboxUrl = '';
let cleaning = false;
const keepOnFailure = process.env.BLAXEL_TEST_KEEP_ON_FAILURE === 'true';

function fail(message) { throw new Error(message); }
function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) fail(`${name} is required`);
  return value;
}
function requiredVersion(name, value) {
  if (!/^3\.\d+\.\d+$/.test(value)) fail(`${name} must be a stable GOST v3 version`);
  return value;
}
function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value || fallback);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}
function alphaNumeric(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => alphabet[randomBytes(1)[0] % alphabet.length]).join('');
}
function parseKey(value) {
  const separator = value.indexOf('|');
  const workspace = value.slice(0, separator).trim();
  const apiKey = value.slice(separator + 1).trim();
  if (separator < 1 || separator !== value.lastIndexOf('|') || !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(workspace) || apiKey.length < 8) {
    fail('BLAXEL_TEST_KEY must use BLAXEL_WORKSPACE|BLAXEL_API_KEY');
  }
  return { workspace, apiKey };
}
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

async function blaxel(method, path, body) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      'X-Blaxel-Authorization': `Bearer ${apiKey}`,
      'X-Blaxel-Workspace': workspace,
      'Blaxel-Version': apiVersion,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Blaxel API ${method} ${path} failed (${response.status}): ${detail || response.statusText}`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

async function waitForDeployment(name) {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    const sandbox = await blaxel('GET', `/sandboxes/${encodeURIComponent(name)}`);
    if (sandbox.status === 'DEPLOYED' && sandbox.metadata?.url) return sandbox;
    if (['FAILED', 'TERMINATED', 'DEACTIVATED', 'DELETING'].includes(String(sandbox.status))) throw new Error(`Blaxel sandbox ${name} entered ${sandbox.status}`);
    await wait(1500);
  }
  throw new Error(`Blaxel sandbox ${name} did not deploy in time`);
}

async function exec(sandboxUrl, name, command, env = {}, waitForCompletion = false, timeout = 0) {
  const url = new URL(sandboxUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.bl.run')) throw new Error('Blaxel returned an invalid sandbox API URL');
  const response = await fetch(`${url.origin}/process`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, command, env, waitForCompletion, timeout, restartOnFailure: !waitForCompletion, maxRestarts: waitForCompletion ? 0 : 1000 }),
  });
  if (!response.ok) throw new Error(`Blaxel sandbox process ${name} failed (${response.status}): ${(await response.text()).slice(0, 500) || response.statusText}`);
  if (waitForCompletion) {
    const result = await response.json();
    const output = [result.logs, result.stderr, result.stdout].filter(Boolean).join('\n').slice(-1000);
    if (result.exitCode !== undefined && result.exitCode !== 0) throw new Error(`Blaxel sandbox process ${name} exited with ${result.exitCode}: ${output || 'no process output returned'}`);
    return result;
  }
}

function waitForProxy(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => socksAuth(publicHost, TEST_PORT, socksUsername, socksPassword, 5000)
      .then(ok => ok ? resolve() : Date.now() >= deadline ? reject(new Error(`SOCKS5 endpoint ${publicHost}:${TEST_PORT} did not become reachable`)) : setTimeout(attempt, 1000))
      .catch(() => Date.now() >= deadline ? reject(new Error(`SOCKS5 endpoint ${publicHost}:${TEST_PORT} did not become reachable`)) : setTimeout(attempt, 1000));
    attempt();
  });
}

function socksAuth(host, port, username, password, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = result => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x02])));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting' && buffer.length >= 2) {
        if (buffer[0] !== 0x05 || buffer[1] !== 0x02) return finish(false);
        buffer = buffer.subarray(2); stage = 'auth';
        const user = Buffer.from(username); const pass = Buffer.from(password);
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      }
      if (stage === 'auth' && buffer.length >= 2) finish(buffer[0] === 0x01 && buffer[1] === 0x00);
    });
  });
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function cleanup(exitCode = 0) {
  if (cleaning) return;
  cleaning = true;
  if (sandboxName) {
    process.stdout.write(`\n[blaxel-test] Cleaning sandbox ${sandboxName}…\n`);
    try { await blaxel('DELETE', `/sandboxes/${encodeURIComponent(sandboxName)}`); }
    catch (error) { process.stderr.write(`[blaxel-test] Cleanup failed: ${error instanceof Error ? error.message : error}\n`); exitCode = 1; }
  }
  process.exit(exitCode);
}

async function diagnose() {
  if (!sandboxUrl) return;
  try {
    const result = await exec(sandboxUrl, 'diagnose-gost', 'echo "--- gost-socks ---"; tail -n 80 /tmp/gost-socks.log 2>&1 || true; echo "--- gost-tunnel ---"; tail -n 80 /tmp/gost-tunnel.log 2>&1 || true', {}, true, 20);
    if (result?.logs) process.stderr.write(`\n[blaxel-test] GOST diagnostics:\n${result.logs.slice(-4000)}\n`);
  } catch (error) {
    process.stderr.write(`[blaxel-test] Could not retrieve GOST diagnostics: ${error instanceof Error ? error.message : error}\n`);
  }
}

process.once('SIGINT', () => void cleanup(0));
process.once('SIGTERM', () => void cleanup(0));
process.once('uncaughtException', error => { process.stderr.write(`${error.stack || error}\n`); void cleanup(1); });
process.once('unhandledRejection', error => { process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`); void cleanup(1); });

try {
  sandboxName = `nodenesia-gost-test-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  process.stdout.write(`[blaxel-test] Creating sandbox ${sandboxName} in ${workspace}/${region}…\n`);
  await blaxel('POST', '/sandboxes', {
    metadata: { name: sandboxName, displayName: 'Nodenesia temporary GOST test', labels: { managedBy: 'nodenesia-gost-test', tunnelPort: String(TEST_PORT) } },
    spec: { enabled: true, region, runtime: { image, memory, ttl: '1h' } },
  });
  const sandbox = await waitForDeployment(sandboxName);
  sandboxUrl = sandbox.metadata.url;
  const install = `if ! command -v curl >/dev/null 2>&1; then (apk add --no-cache curl || (apt-get update && apt-get install -y curl)); fi; cd /tmp && (curl -fsSL -o /tmp/gost.tar.gz "https://github.com/go-gost/gost/releases/download/v${gostVersion}/gost_${gostVersion}_linux_amd64.tar.gz" || curl -fsSL -o /tmp/gost.tar.gz "https://github.com/go-gost/gost/releases/download/v${gostVersion}/gost_${gostVersion}_linux_amd64v3.tar.gz") && tar -xzf /tmp/gost.tar.gz -C /tmp gost && chmod +x /tmp/gost && /tmp/gost -V`;
  await exec(sandboxUrl, 'install-gost', install, {}, true, 90);
  const egressCheck = "fetch('https://api.ipify.org').then(response=>{if(!response.ok)throw new Error('HTTP '+response.status);return response.text()}).then(ip=>console.log(ip.trim())).catch(error=>{console.error('ERROR '+error.message);process.exit(1)})";
  const egress = await exec(sandboxUrl, 'check-egress-ip', `node -e ${shellQuote(egressCheck)}`, {}, true, 15);
  const egressOutput = [egress?.logs, egress?.stdout].filter(Boolean).join('\n').trim();
  if (egressOutput) process.stdout.write(`[blaxel-test] Sandbox egress IP: ${egressOutput}\n`);
  const rendezvousCheck = [
    "const net=require('net');",
    'const host=process.env.TEST_HOST;',
    'const port=Number(process.env.TEST_PORT);',
    'const started=Date.now();',
    'const socket=net.createConnection({host,port});',
    'socket.setTimeout(5000);',
    "socket.on('connect',()=>{console.log('CONNECTED '+host+':'+port+' local='+socket.localAddress+' in '+(Date.now()-started)+'ms');process.exit(0)});",
    "socket.on('timeout',()=>{console.error('TIMEOUT '+host+':'+port+' after '+(Date.now()-started)+'ms');process.exit(1)});",
    "socket.on('error',error=>{console.error('ERROR '+(error.code||'UNKNOWN')+' '+error.message);process.exit(1)});",
  ].join('');
  await exec(sandboxUrl, 'check-rendezvous', `node -e ${shellQuote(rendezvousCheck)}`, { TEST_HOST: masterHost, TEST_PORT: String(rendezvousPort) }, true, 10);
  const query = gostQuery();
  await exec(sandboxUrl, 'gost-socks', 'while true; do /tmp/gost -L="socks5://${SOCKS_USER}:${SOCKS_PASS}@127.0.0.1:${LOCAL_PORT}${SOCKS_QUERY}" >> /tmp/gost-socks.log 2>&1; sleep 1; done', {
    SOCKS_USER: encodeURIComponent(socksUsername), SOCKS_PASS: encodeURIComponent(socksPassword), LOCAL_PORT: String(localPort), SOCKS_QUERY: query,
  }, false);
  const scheme = tunnelTransport === 'tcp' ? 'socks5' : `socks5+${tunnelTransport}`;
  await exec(sandboxUrl, 'gost-tunnel', 'while true; do /tmp/gost -L="rtcp://:${BIND_PORT}/127.0.0.1:${LOCAL_PORT}" -F="${TUNNEL_SCHEME}://${TUNNEL_USER}:${TUNNEL_PASS}@${MASTER_HOST}:${RENDEZVOUS_PORT}" >> /tmp/gost-tunnel.log 2>&1; sleep 2; done', {
    BIND_PORT: String(TEST_PORT), LOCAL_PORT: String(localPort), TUNNEL_SCHEME: scheme,
    TUNNEL_USER: encodeURIComponent(tunnelUsername), TUNNEL_PASS: encodeURIComponent(tunnelPassword), MASTER_HOST: masterHost, RENDEZVOUS_PORT: String(rendezvousPort),
  }, false);
  await waitForProxy();
  process.stdout.write(`\n[blaxel-test] SOCKS5 ready: socks5://${socksUsername}:${socksPassword}@${publicHost}:${TEST_PORT}\n[blaxel-test] Press Ctrl+C to delete the sandbox and release port ${TEST_PORT}.\n`);
  await new Promise(() => {});
} catch (error) {
  process.stderr.write(`[blaxel-test] ${error instanceof Error ? error.message : error}\n`);
  await diagnose();
  if (keepOnFailure && sandboxName) {
    process.stderr.write(`[blaxel-test] Keeping ${sandboxName} for inspection; delete it manually in Blaxel Console.\n`);
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
