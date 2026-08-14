#!/usr/bin/env node
if (process.env.ALLOW_LEGACY_WORKER !== 'true') {
  throw new Error('worker/app.js is reference-only and disabled by default. Use the Nest proxy provisioning module.');
}
/**
 * codex resume 019fae02-1ad5-7812-8a81-768010facac6
 * 
 * E2B GOST Reverse-Tunnel Proxy — Multi-Sandbox Edition v7
 *
 * v7 changes (replace E2B proxy-URL + Python wsbridge with ginuerzh/gost):
 *
 *   BEFORE (v6 and earlier): each sandbox ran a Python `websockets` bridge
 *   that was only reachable through E2B's own reverse-proxy ingress URL
 *   (wss://PORT-sandboxId.e2b.app). This Node process then implemented the
 *   SOCKS5 protocol itself and relayed every byte of every client
 *   connection over that WS link. That meant (a) all traffic transited
 *   E2B's ingress infra, (b) Node had to hand-roll SOCKS5 parsing +
 *   per-slot load balancing, and (c) each sandbox's public exposure was an
 *   E2B-assigned hostname, not something this host controlled.
 *
 *   AFTER (v7): E2B's proxy URL is not used at all. Each sandbox downloads
 *   a static `gost` binary (https://github.com/ginuerzh/gost) and runs two
 *   things in a bash respawn loop:
 *     1. A LOCAL, password-protected SOCKS5 server bound to loopback only:
 *          gost -L=socks5://user:pass@127.0.0.1:<localSocksPort>
 *     2. A REVERSE bind tunnel that dials OUT (sandbox has no public IP but
 *        does have outbound internet) to this host's public IP, and asks
 *        the far end to open a dedicated public port that forwards
 *        straight into that local SOCKS5 server:
 *          gost -L=rtcp://:<bindPort>/127.0.0.1:<localSocksPort> \
 *               -F=wss://<GOST_HOST>:<rendezvousPort>
 *
 *   On THIS host, ONE `gost` server process (spawned once at startup, not
 *   per sandbox) listens on <rendezvousPort> for incoming tunnel
 *   connections from every sandbox in the pool:
 *          gost -L=socks5://user:pass@:<rendezvousPort>
 *   Each sandbox's own `-L=rtcp://:<bindPort>/...` argument is what causes
 *   gost to open THAT specific port on this host the moment that
 *   sandbox's tunnel connects — so every slot gets its own dedicated
 *   public endpoint, socks5://<GOST_HOST>:<bindPort>, with zero Node-side
 *   SOCKS5 parsing, relaying, or per-slot `net.createServer` involved.
 *   Everything that used to be handleClient()/parseSocks5()/pickSlot()/
 *   startProxy() is gone — gost does 100% of the byte-level proxying now.
 *
 *   Trade-off worth being explicit about: because traffic no longer
 *   transits this Node process, this process can no longer see individual
 *   connections or count bytes up/down per sandbox the way v6's dashboard
 *   did — that telemetry is gone unless pulled from gost itself (gost v2
 *   doesn't expose a metrics API the way v3/go-gost does). The dashboard
 *   below reflects that honestly: it shows pool/tunnel health (ready /
 *   recreating / error, last reachability check, TTL, recreation count),
 *   not live per-connection traffic counters.
 *
 *   The rendezvous GOST SOCKS5 service and each sandbox's local SOCKS5 server
 *   both require the configured username/password. The default direct TCP
 *   transport avoids WebSocket framing; WSS remains available by config.
 *   The bind ports
 *   remain protected end-to-end because clients negotiate authentication
 *   directly with the sandbox's local SOCKS5 service through the raw
 *   tunnel. Firewall <rendezvousPort> to only what you need as additional
 *   defense in depth. For more advanced tunnel identity and policy,
 *   go-gost/gost v3 has an authenticated tunnel/Ingress model:
 *   https://gost.run/en/tutorials/reverse-proxy-tunnel/ — noted, not used
 *   here since you asked specifically for ginuerzh/gost (v2).
 *
 *   gost version is pinned (GOST_VERSION below) rather than resolved via
 *   the GitHub releases API at sandbox-init time — with up to
 *   sandboxCount sandboxes initializing concurrently, hitting the
 *   anonymous GitHub API's rate limit is a real, easily-reproduced failure
 *   (this exact 60-req/hr limit was hit while drafting this script). A
 *   pinned release download URL does not touch that API at all.
 *
 * v4/v5/v6 notes (unchanged, still describe the surrounding sandbox-pool
 * lifecycle — batching, keepalive, circuit breaker, orphan reconciliation,
 * resource watchdog, daily reset; only the transport layer between "Node"
 * and "sandbox" changed in v7):
 *   - requestTimeoutMs passed to all E2B SDK calls to avoid false timeouts
 *     under load cascading into recreate storms.
 *   - kill() is fire-and-forget; reconcileOrphans() periodically lists what
 *     each API key actually has running and kills anything this pool isn't
 *     tracking, so a timed-out kill can't silently leak sandbox quota.
 *   - All "unplanned" recreates (keepalive-fail, tunnel-unreachable,
 *     scheduled error recovery) funnel through ONE global semaphore
 *     (maxConcurrentRecreates) instead of independent counters stacking.
 *   - Bulk kill operations use mapLimit() instead of unbounded Promise.all().
 *   - A resource watchdog logs open-FD count and RSS memory periodically.
 *
 * v7.1 changes (resilience against transient E2B API/network blips):
 *
 *   The 2026-08-04 incident logs showed two failure modes that are really
 *   ONE root cause wearing two masks. During short (30-90s) windows where
 *   outbound fetches to the E2B API were failing at the TCP/DNS layer
 *   (undici's raw "fetch failed", not an HTTP error — meaning the request
 *   never got a response at all), TWO things happened:
 *
 *     1. old.kill() in recreateSlot() would throw "fetch failed". Because
 *        that error was swallowed into oldKillError and NOT retried, the
 *        old sandbox's gost reverse-tunnel process very likely kept running
 *        on E2B's side (the kill request may never have reached E2B), so
 *        its rtcp bind on this host's gost rendezvous process kept the
 *        slot's public bindPort occupied.
 *     2. waitForBindPortRelease() then legitimately timed out at 20s
 *        (portReleaseTimeoutMs) waiting for a port that was never going to
 *        free up on its own, and initSlot() aborted with "bind port ...
 *        still owned by a previous tunnel" — sending the slot straight to
 *        'error' instead of retrying the kill.
 *
 *   Fix: (a) wrap the handful of E2B SDK calls most exposed to this failure
 *   mode (kill, list, create) in a small bounded retry that only retries
 *   genuinely transient errors (raw fetch failure / SDK timeout), never
 *   real 4xx responses; (b) widen portReleaseTimeoutMs so a slower-than-
 *   usual but real port release isn't mistaken for a stuck tunnel; (c) stop
 *   conflating "kill request itself failed to reach E2B" with "sandbox
 *   confirmed gone" when deciding how to log/handle a failed kill; (d)
 *   surface gost-rendezvous-process restarts and recent recreate-error
 *   counts on the dashboard so a future network blip is visible as a single
 *   correlated event instead of dozens of unrelated-looking per-slot errors.
 */

import net     from 'net';
import http    from 'http';
import fs      from 'fs';
import path    from 'path';
import crypto  from 'crypto';
import { Sandbox } from 'e2b';
import blessed from 'blessed';
import { spawn, exec } from 'child_process';
import dotenv  from 'dotenv';
dotenv.config();

// ─── GOST BINARY (pinned — see rationale in header comment) ────────────────
const GOST_VERSION = process.env.GOST_VERSION || '2.12.0';
// Candidates tried in order on the sandbox side (some releases only ship
// microarch-tagged builds; amd64 (v1, baseline) is tried first for maximum
// compatibility, falling back to v3/v2 tags if that asset doesn't exist).
const GOST_ASSET_CANDIDATES = [
  `gost_${GOST_VERSION}_linux_amd64.tar.gz`,
  `gost_${GOST_VERSION}_linux_amd64v3.tar.gz`,
  `gost_${GOST_VERSION}_linux_amd64v2.tar.gz`,
];
const GOST_RELEASE_BASE = `https://github.com/ginuerzh/gost/releases/download/v${GOST_VERSION}`;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  dashPort:        parseInt(process.env.DASH_PORT     || '8080'),
  sandboxCount:    parseInt(process.env.SANDBOX_COUNT || '18'),
  e2bApiKeys:      (process.env.E2B_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean),
  e2bApiKey:       (process.env.E2B_API_KEY || '').trim(),
  // E2B hard lifetime and proactive replacement window. Renewing only two
  // minutes early is unsafe when many slots expire together but replacement
  // concurrency is intentionally limited.
  sandboxTtlMs:    parseInt(process.env.E2B_SANDBOX_TIMEOUT_MINUTES || '60') * 60 * 1000,
  sandboxRenewBeforeMs: parseInt(process.env.E2B_RENEW_BEFORE_MINUTES || '10') * 60 * 1000,
  replacementMaxAttempts: parseInt(process.env.REPLACEMENT_MAX_ATTEMPTS || '3'),
  replacementRetryDelayMs: parseInt(process.env.REPLACEMENT_RETRY_DELAY_MS || '5000'),
  keepaliveMs:     30 * 1000,
  sandboxConcurrency: parseInt(process.env.SANDBOX_CONCURRENCY || '4'),
  sandboxBatchDelayMs: parseInt(process.env.SANDBOX_BATCH_DELAY_MS || '250'),
  sandboxTemplate: process.env.E2B_TEMPLATE || 'nlhz8vlwyupq845jsdg9',
  connTimeoutMs:   120_000,
  errorRecoveryEnabled:    process.env.ERROR_RECOVERY_ENABLED !== 'false',
  errorRecoveryIntervalMs: parseInt(process.env.ERROR_RECOVERY_INTERVAL_MS || '20'   ) * 1000,
  errorRecoveryMaxBackoffMs: parseInt(process.env.ERROR_RECOVERY_MAX_BACKOFF_MS || '600') * 1000,
  errorRecoveryInitialBackoffMs: parseInt(process.env.ERROR_RECOVERY_INITIAL_BACKOFF_MS || '10') * 1000,
  errorRecoveryConcurrency: parseInt(process.env.ERROR_RECOVERY_CONCURRENCY || '2'),

  keepaliveMissThreshold: parseInt(process.env.KEEPALIVE_MISS_THRESHOLD || '3'),
  maxConcurrentUnplannedRecreate: parseInt(process.env.MAX_CONCURRENT_UNPLANNED_RECREATE || '2'),

  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '30000'),
  reconcileIntervalMs: parseInt(process.env.RECONCILE_INTERVAL_MS || '300') * 1000,
  // v7.2: how long after startup the FIRST orphan-reconciliation pass runs.
  // Previously there was no eager first pass — the pool had to wait a full
  // reconcileIntervalMs (5min default) before any leftover orphan from a
  // bad restart got cleaned up, during which fresh slots could repeatedly
  // fail with "bind port still owned by a previous tunnel".
  reconcileFirstRunDelayMs: parseInt(process.env.RECONCILE_FIRST_RUN_DELAY_MS || '30') * 1000,
  maxConcurrentRecreates: parseInt(process.env.MAX_CONCURRENT_RECREATES || process.env.MAX_CONCURRENT_UNPLANNED_RECREATE || '2'),

  maxGlobalConns: parseInt(process.env.MAX_GLOBAL_CONNS || '0'),
  fdWarnThreshold: parseInt(process.env.FD_WARN_THRESHOLD || '8000'),
  memWarnMb:       parseInt(process.env.MEM_WARN_MB || '2048'),
  resourceWatchdogIntervalMs: parseInt(process.env.RESOURCE_WATCHDOG_INTERVAL_MS || '10') * 1000,

  // ── v7 gost transport config ────────────────────────────────────────────
  // Public IP/hostname of THIS host — what sandboxes dial out to, and what
  // you give to actual SOCKS5 clients as socks5://gostHost:bindPort.
  gostHost:          process.env.GOST_PUBLIC_HOST || '103.38.236.171',
  // Port where this host's ONE gost server listens for incoming reverse
  // tunnel connections from every sandbox (the "rendezvous" point).
  rendezvousPort:    parseInt(process.env.GOST_RENDEZVOUS_PORT || '28443'),
  // "tcp" avoids the extra WebSocket + TLS framing. GOST-to-GOST SOCKS5
  // still negotiates its own encrypted/authenticated session. Set this to
  // "wss" only when an outbound firewall requires WebSocket traffic.
  tunnelTransport:   (process.env.GOST_TUNNEL_TRANSPORT || 'tcp').toLowerCase(),
  // Base for each sandbox's dedicated public SOCKS5 port: slot i is exposed
  // at gostHost:(gostBindPortBase + i).
  gostBindPortBase:  parseInt(process.env.GOST_BIND_PORT_BASE || '29000'),
  // Loopback-only port inside each sandbox where its local SOCKS5 server runs.
  localSocksPort:    parseInt(process.env.GOST_LOCAL_SOCKS_PORT || '1080'),
  // SOCKS5 username/password required by every sandbox's local socks5
  // server — and therefore also required by anyone connecting to its public
  // bind port, since the auth negotiation passes through the tunnel
  // end-to-end. Set these explicitly in .env; if left unset a random
  // password is generated per run and logged once (WARN level) so you can
  // capture it — but it will change on every restart of this process.
  socksUser: process.env.GOST_SOCKS_USER || 'e2b',
  socksPass: process.env.GOST_SOCKS_PASS || crypto.randomBytes(12).toString('hex'),
  // Destination used by the end-to-end health check. A successful SOCKS5
  // CONNECT proves that authentication and traffic forwarding both work.
  healthcheckHost: process.env.GOST_HEALTHCHECK_HOST || '1.1.1.1',
  healthcheckPort: parseInt(process.env.GOST_HEALTHCHECK_PORT || '80'),
  // Widened from 20s: a "fetch failed" during old.kill() can leave a real,
  // still-running tunnel behind that legitimately takes longer than 20s to
  // notice its peer is gone and release the rtcp bind. See v7.1 note above.
  portReleaseTimeoutMs: parseInt(process.env.GOST_PORT_RELEASE_TIMEOUT_MS || '45000'),
  errorLogDedupeMs: parseInt(process.env.ERROR_LOG_DEDUPE_MS || '60000'),
  // Path to the gost binary on THIS host (downloaded once at startup if missing).
  gostBinPath: process.env.GOST_BIN_PATH || path.join(process.cwd(), 'bin', 'gost'),

  // ── v7.1 retry config for transient E2B API/network failures ───────────
  sdkRetryAttempts: parseInt(process.env.SDK_RETRY_ATTEMPTS || '3'),
  sdkRetryBaseDelayMs: parseInt(process.env.SDK_RETRY_BASE_DELAY_MS || '1000'),
};

const SANDBOX_COUNT_MODE = (process.env.SANDBOX_COUNT_MODE || (CONFIG.e2bApiKeys && CONFIG.e2bApiKeys.length > 1 ? 'per_key' : 'total')).toLowerCase();
const TOTAL_SANDBOXES = (SANDBOX_COUNT_MODE === 'per_key' && CONFIG.e2bApiKeys && CONFIG.e2bApiKeys.length > 0)
  ? CONFIG.sandboxCount * CONFIG.e2bApiKeys.length
  : CONFIG.sandboxCount;

const ERROR_LOG_FILE = process.env.ERROR_LOG_FILE || new URL('./sandbox-errors.log', import.meta.url);
const recentErrorFingerprints = new Map();

function maskApiKey(apiKey) {
  if (!apiKey) return 'none';
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}***${apiKey.slice(-2)}`;
  return `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`;
}

function getApiKeyForSlot(slotIndex) {
  return (CONFIG.e2bApiKeys && CONFIG.e2bApiKeys.length)
    ? CONFIG.e2bApiKeys[slotIndex % CONFIG.e2bApiKeys.length]
    : (CONFIG.e2bApiKey || undefined);
}

function getApiKeyIndex(apiKey) {
  if (!apiKey) return -1;
  const idx = CONFIG.e2bApiKeys.indexOf(apiKey);
  return idx >= 0 ? idx : 0;
}

function errorToMeta(error) {
  if (!error) return { message: 'Unknown error' };
  return {
    message: error?.message || String(error),
    name: error?.name,
    code: error?.code,
    stack: error?.stack,
  };
}

function writeErrorLog(event, details, dedupeKey) {
  const now = Date.now();
  const fingerprint = dedupeKey || `${event}:${JSON.stringify(details)}`;
  const lastWrittenAt = recentErrorFingerprints.get(fingerprint) || 0;
  if (now - lastWrittenAt < CONFIG.errorLogDedupeMs) return;
  recentErrorFingerprints.set(fingerprint, now);
  if (recentErrorFingerprints.size > 1000) {
    for (const [key, writtenAt] of recentErrorFingerprints) {
      if (now - writtenAt >= CONFIG.errorLogDedupeMs) recentErrorFingerprints.delete(key);
    }
  }

  const entry = { ts: new Date().toISOString(), event, ...details };
  try {
    fs.appendFileSync(ERROR_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (logError) {
    console.error('[ERROR LOG WRITE FAILED]', logError?.message || logError);
  }
}

function resetErrorLog() {
  try {
    fs.writeFileSync(ERROR_LOG_FILE, '', 'utf8');
    recentErrorFingerprints.clear();
  } catch (error) {
    console.error('[ERROR LOG RESET FAILED]', error?.message || error);
  }
}

// ─── v7.1: TRANSIENT-ERROR RETRY WRAPPER ────────────────────────────────────
// The 2026-08-04 incident showed E2B SDK calls failing with raw network
// errors (undici "fetch failed" — the request never got a response) and
// SDK-level timeouts (TimeoutError / code 23, "operation aborted due to
// timeout"). Both are classic transient conditions: the right response is
// a short bounded retry, NOT immediately cascading into a slot recreate or
// error state. Real API errors (4xx auth/validation failures, 404 not
// found) are NOT retried here — retrying those would just waste time.
function isTransientSdkError(err) {
  if (!err) return false;
  const msg = err?.message || '';
  if (msg === 'fetch failed') return true;                 // raw undici network failure
  if (err?.name === 'TimeoutError') return true;            // SDK/undici timeout
  if (err?.code === 23) return true;                        // DOMException AbortError code
  if (/aborted due to timeout/i.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(msg)) return true;
  return false;
}

// Real "this sandbox is already gone" responses (404/not-found) should be
// treated as success, not as a failure to retry — retrying a kill against a
// sandbox E2B already reports gone just wastes the retry budget.
function isNotFoundSdkError(err) {
  if (!err) return false;
  const msg = err?.message || '';
  if (err?.status === 404) return true;
  if (/not[\s_-]?found/i.test(msg)) return true;
  return false;
}

async function withRetry(fn, { attempts = CONFIG.sdkRetryAttempts, baseDelayMs = CONFIG.sdkRetryBaseDelayMs, label = 'sdk_call' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isNotFoundSdkError(err)) throw err; // don't retry — nothing to wait for
      if (!isTransientSdkError(err) || attempt >= attempts) throw err;
      const delay = baseDelayMs * attempt;
      writeErrorLog('sdk_call_retry', { label, attempt, attempts, delayMs: delay, ...errorToMeta(err) }, `${label}:retry`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

function gostScheme() {
  if (CONFIG.tunnelTransport === 'tcp') return 'socks5';
  if (CONFIG.tunnelTransport === 'ws') return 'socks5+ws';
  if (CONFIG.tunnelTransport === 'wss') return 'socks5+wss';
  throw new Error(`Unsupported GOST_TUNNEL_TRANSPORT=${CONFIG.tunnelTransport}; expected tcp, ws, or wss`);
}

function persistGostOutput(event, data) {
  for (const line of data.toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    // GOST writes routine accepts and connection-open messages to stderr.
    // Keeping all of those made sandbox-errors.log grow rapidly and added a
    // synchronous disk write on every connection.
    if (/\b(?:error|fail(?:ed|ure)?|timeout|panic|fatal)\b|address already in use|connection reset|broken pipe/i.test(line)) {
      const normalizedLine = line
        .replace(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/, '')
        .replace(/(\[(?:socks5|ws)\]\s+)(?:\d{1,3}\.){3}\d{1,3}:\d+/, '$1<peer>');
      writeErrorLog(event, { line }, `${event}:${normalizedLine}`);
    }
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); }
      catch (err) { results[i] = { __error: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const deleteAllSandboxes = async (apiKeys) => {
  if (!apiKeys || !apiKeys.length) return;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    let items = [];
    try {
      items = await withRetry(
        () => Sandbox.list({ apiKey, query: { state: 'running' } }),
        { label: 'sandbox_list_startup' }
      );
    } catch (error) {
      writeErrorLog('sandbox_list_failed', { apiKeyIndex: i, apiKeyMasked: maskApiKey(apiKey), ...errorToMeta(error) });
      console.error(`[API KEY ${i}] ERROR: `, error?.message || error);
      continue;
    }
    await mapLimit(items, CONFIG.sandboxConcurrency, item =>
      withRetry(
        () => Sandbox.kill(item.sandboxId, { apiKey, requestTimeoutMs: CONFIG.requestTimeoutMs }),
        { label: 'sandbox_kill_startup' }
      ).catch(err => {
        writeErrorLog('sandbox_kill_failed', { apiKeyIndex: i, apiKeyMasked: maskApiKey(apiKey), sandboxId: item.sandboxId, ...errorToMeta(err) });
        console.error(`[API KEY ${i}] ERROR: `, err?.message || err);
      })
    );
  }
};

// ─── GOST INSTALL (sandbox side) ─────────────────────────────────────────────
// Tries each candidate asset in order with curl -f (fail on 404) so a
// missing microarch build doesn't abort the whole install.
function buildGostInstallCmd() {
  const tries = GOST_ASSET_CANDIDATES.map(name =>
    `curl -fsSL -o /tmp/gost.tar.gz "${GOST_RELEASE_BASE}/${name}" && echo "GOT:${name}"`
  ).join(' || ');
  return `
cd /tmp
${tries} || { echo "GOST_DOWNLOAD_FAILED"; exit 1; }
tar -xzf /tmp/gost.tar.gz -C /tmp gost
chmod +x /tmp/gost
/tmp/gost -V
`.trim();
}

function buildStartLocalSocksCmd() {
  const { socksUser, socksPass, localSocksPort } = CONFIG;
  const encodedUser = encodeURIComponent(socksUser);
  const encodedPass = encodeURIComponent(socksPass);
  return `while true; do /tmp/gost -L=socks5://${encodedUser}:${encodedPass}@127.0.0.1:${localSocksPort} >> /tmp/gost-socks.log 2>&1; sleep 1; done`;
}

function buildProbeLocalSocksCmd() {
  return `for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/${CONFIG.localSocksPort}) 2>/dev/null && echo UP && exit 0; sleep 0.5; done; echo TIMEOUT`;
}

function buildStartReverseTunnelCmd(bindPort) {
  const { gostHost, rendezvousPort, localSocksPort, socksUser, socksPass } = CONFIG;
  const tunnelUser = encodeURIComponent(socksUser);
  const tunnelPass = encodeURIComponent(socksPass);
  return `while true; do /tmp/gost -L=rtcp://:${bindPort}/127.0.0.1:${localSocksPort} -F=${gostScheme()}://${tunnelUser}:${tunnelPass}@${gostHost}:${rendezvousPort}?mbind=true >> /tmp/gost-tunnel.log 2>&1; sleep 2; done`;
}

// ─── HOST-SIDE SOCKS5 REACHABILITY CHECK ────────────────────────────────────
// Complete username/password negotiation followed by a CONNECT request.
// Merely opening the bind port or receiving a greeting is not sufficient:
// both can succeed while authentication or actual forwarding is broken.
function checkSocks5Reachable(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    let stage = 'greeting';
    let pending = Buffer.alloc(0);
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {}; resolve(ok); };
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write(Buffer.from([0x05, 0x01, 0x02]));
    });
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.on('data', (data) => {
      pending = Buffer.concat([pending, data]);

      if (stage === 'greeting' && pending.length >= 2) {
        if (pending[0] !== 0x05 || pending[1] !== 0x02) return finish(false);
        pending = pending.subarray(2);

        const username = Buffer.from(CONFIG.socksUser);
        const password = Buffer.from(CONFIG.socksPass);
        if (!username.length || username.length > 255 || !password.length || password.length > 255) {
          return finish(false);
        }
        sock.write(Buffer.concat([
          Buffer.from([0x01, username.length]), username,
          Buffer.from([password.length]), password,
        ]));
        stage = 'auth';
      }

      if (stage === 'auth' && pending.length >= 2) {
        if (pending[0] !== 0x01 || pending[1] !== 0x00) return finish(false);
        pending = pending.subarray(2);

        const host = Buffer.from(CONFIG.healthcheckHost);
        if (!host.length || host.length > 255) return finish(false);
        const targetPort = Buffer.allocUnsafe(2);
        targetPort.writeUInt16BE(CONFIG.healthcheckPort);
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          host,
          targetPort,
        ]));
        stage = 'connect';
      }

      if (stage === 'connect' && pending.length >= 5) {
        if (pending[0] !== 0x05 || pending[1] !== 0x00) return finish(false);
        const atyp = pending[3];
        let replyLength;
        if (atyp === 0x01) replyLength = 10;
        else if (atyp === 0x04) replyLength = 22;
        else if (atyp === 0x03 && pending.length >= 5) replyLength = 7 + pending[4];
        else return finish(false);
        if (pending.length >= replyLength) finish(true);
      }
    });
    sock.on('error', () => finish(false));
    sock.on('end', () => finish(false));
  });
}

function isTcpPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    const socket = net.connect({ host: '127.0.0.1', port }, () => finish(true));
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForBindPortRelease(port, timeoutMs = CONFIG.portReleaseTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isTcpPortOpen(port))) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return !(await isTcpPortOpen(port));
}

// ─── POOL ────────────────────────────────────────────────────────────────────
const pool = Array.from({ length: TOTAL_SANDBOXES }, (_, i) => ({
  index:       i,
  sandbox:     null,
  sandboxId:   null,
  publicIp:    null,       // sandbox's own egress IP (informational only)
  bindPort:    CONFIG.gostBindPortBase + i,   // fixed for the slot's lifetime
  status:      'starting',
  createdAt:   null,
  expiresAt:   null,
  errors:      0,
  recreations: 0,
  lastErrorAt:     null,
  nextRetryAt:     null,
  backoffMs:       0,
  recoveryInFlight: false,
  recreatePromise: null,
  keepaliveMisses:  0,
  socksMisses:      0,       // consecutive failed reachability checks on bindPort
  lastCheckOk:      null,
  lastCheckAt:      null,
}));

const gStats = {
  startTime: Date.now(),
  errors:    0,
};

// ─── v7.1: RECENT-ERROR CORRELATION TRACKING ─────────────────────────────────
// A burst of unrelated-looking per-slot errors within a short window is
// almost always ONE underlying event (network blip, gost restart), not N
// independent failures. Track a rolling window so the dashboard/log can
// surface "N slot errors in the last 2 minutes" as a single correlated
// signal instead of noise.
const recentSlotErrors = [];
const RECENT_ERROR_WINDOW_MS = 120_000;
function recordSlotError(slotIndex, reason) {
  const now = Date.now();
  recentSlotErrors.push({ ts: now, slotIndex, reason });
  while (recentSlotErrors.length && now - recentSlotErrors[0].ts > RECENT_ERROR_WINDOW_MS) {
    recentSlotErrors.shift();
  }
}
function recentErrorBurstCount() {
  const now = Date.now();
  while (recentSlotErrors.length && now - recentSlotErrors[0].ts > RECENT_ERROR_WINDOW_MS) {
    recentSlotErrors.shift();
  }
  return recentSlotErrors.length;
}

// ─── GLOBAL RECREATE SEMAPHORE ───────────────────────────────────────────────
let recreateInFlight = 0;
const recreateQueue = [];

function queueRecreate(slot, reason, fn = recreateSlot) {
  if (slot.recreatePromise) return slot.recreatePromise;
  if (slot.status === 'recreating') return Promise.resolve();
  slot.recreatePromise = new Promise((resolve) => {
    recreateQueue.push({ slot, reason, fn, resolve });
    drainRecreateQueue();
  });
  return slot.recreatePromise;
}

function drainRecreateQueue() {
  while (recreateInFlight < CONFIG.maxConcurrentRecreates && recreateQueue.length) {
    const { slot, reason, fn, resolve } = recreateQueue.shift();
    if (slot.status === 'recreating') {
      slot.recreatePromise = null;
      resolve();
      continue;
    }
    recreateInFlight++;
    fn(slot, reason)
      .catch(() => {})
      .finally(() => {
        recreateInFlight--;
        slot.recreatePromise = null;
        resolve();
        drainRecreateQueue();
      });
  }
}

function enqueueUnplannedRecreate(slot, reason) {
  queueRecreate(slot, reason);
}

// ─── SSE ─────────────────────────────────────────────────────────────────────
const sseClients = new Set();

function buildPayload() {
  const ready      = pool.filter(s => s.status === 'ready').length;
  const starting   = pool.filter(s => ['starting', 'recreating'].includes(s.status)).length;
  const errored    = pool.filter(s => s.status === 'error').length;
  return {
    ts:          Date.now(),
    uptime:      Date.now() - gStats.startTime,
    errors:      gStats.errors,
    ready, starting, errored,
    total:       TOTAL_SANDBOXES,
    recreateQueueLen: recreateQueue.length,
    recreateInFlight,
    openFds:     lastKnownFds,
    rssMb:       (process.memoryUsage().rss / 1024 / 1024) | 0,
    gostHost:    CONFIG.gostHost,
    rendezvousPort: CONFIG.rendezvousPort,
    gostServerRestarts,
    recentErrorBurst: recentErrorBurstCount(),
    sandboxes:   pool.map(s => ({
      index:       s.index,
      sandboxId:   s.sandboxId,
      publicIp:    s.publicIp,
      status:      s.status,
      uptime:      s.createdAt ? Date.now() - s.createdAt : 0,
      expiresIn:   s.expiresAt ? Math.max(0, s.expiresAt - Date.now()) : 0,
      errors:      s.errors,
      recreations: s.recreations,
      socksAddr:   `${CONFIG.gostHost}:${s.bindPort}`,
      lastCheckOk: s.lastCheckOk,
      lastCheckAt: s.lastCheckAt,
    })),
  };
}

function pushStats() {
  if (!sseClients.size) return;
  const msg = `data: ${JSON.stringify(buildPayload())}\n\n`;
  for (const r of sseClients) { try { r.write(msg); } catch {} }
}
setInterval(pushStats, 1000);

// ─── BLESSED TUI ─────────────────────────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: 'E2B GOST SOCKS5', fullUnicode: true });

const header  = blessed.box({ top:0,  left:0, width:'100%', height:3,  tags:true, border:{type:'line'}, style:{bg:'black',border:{fg:'cyan'}} });
const statsBox = blessed.box({ top:3, left:0, width:'50%',  height:8,  label:' {bold}Global{/bold} ', tags:true, border:{type:'line'}, style:{border:{fg:'magenta'},label:{fg:'magenta'}}, padding:{left:1} });
const poolBox  = blessed.box({ top:3, right:0,width:'50%',  height:8,  label:' {bold}Pool{/bold} ',   tags:true, border:{type:'line'}, style:{border:{fg:'cyan'},   label:{fg:'cyan'}},    padding:{left:1} });
const logBox   = blessed.log({ top:11,left:0, width:'100%', height:'100%-11', label:' {bold}Log{/bold} ', tags:true, border:{type:'line'}, style:{border:{fg:'green'},label:{fg:'green'}}, padding:{left:1}, scrollable:true, alwaysScroll:true, scrollbar:{ch:'│',style:{fg:'cyan'}} });

screen.append(header); screen.append(statsBox); screen.append(poolBox); screen.append(logBox);
screen.key(['q','C-c'], () => shutdown('quit'));
screen.render();

const fmtDur = ms => { const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60); return h>0?`${h}h ${m%60}m`:m>0?`${m}m ${s%60}s`:`${s}s`; };
const sc     = st => ({starting:'{yellow-fg}',ready:'{green-fg}',recreating:'{magenta-fg}',error:'{red-fg}'}[st]||'{white-fg}');

function renderTUI() {
  const ready    = pool.filter(s=>s.status==='ready').length;
  const starting = pool.filter(s=>['starting','recreating'].includes(s.status)).length;
  const err      = pool.filter(s=>s.status==='error').length;
  const burst    = recentErrorBurstCount();

  header.setContent(
    ` {bold}{cyan-fg}⬡ E2B GOST SOCKS5{/cyan-fg}{/bold}` +
    `   {gray-fg}rendezvous{/gray-fg} {white-fg}${CONFIG.gostHost}:${CONFIG.rendezvousPort}{/white-fg}` +
    `   {gray-fg}dash{/gray-fg} {white-fg}:${CONFIG.dashPort}{/white-fg}` +
    `   {green-fg}${ready}✓{/green-fg}/{white-fg}${TOTAL_SANDBOXES}{/white-fg}` +
    (starting?`  {yellow-fg}${starting}↺{/yellow-fg}`:'') +
    (err?`  {red-fg}${err}✗{/red-fg}`:'') +
    `   {gray-fg}up{/gray-fg} {white-fg}${fmtDur(Date.now()-gStats.startTime)}{/white-fg}` +
    `   {gray-fg}recreate-q{/gray-fg} {white-fg}${recreateQueue.length}{/white-fg}(${recreateInFlight}/${CONFIG.maxConcurrentRecreates})` +
    (burst >= 5 ? `   {red-fg}⚠ ${burst} slot errors/2min — likely a network blip, not per-slot faults{/red-fg}` : '')
  );
  statsBox.setContent(
    `{gray-fg}Ready    {/gray-fg}{green-fg}{bold}${ready}{/bold}{/green-fg}\n` +
    `{gray-fg}Starting {/gray-fg}{yellow-fg}${starting}{/yellow-fg}\n` +
    `{gray-fg}Error    {/gray-fg}{red-fg}${err}{/red-fg}\n` +
    `{gray-fg}Errors(ctr){/gray-fg} {red-fg}${gStats.errors}{/red-fg}\n` +
    `{gray-fg}FDs/RSS{/gray-fg} {white-fg}${lastKnownFds ?? 'n/a'}{/white-fg} / {white-fg}${(process.memoryUsage().rss/1024/1024)|0}MB{/white-fg}\n` +
    `{gray-fg}SOCKS auth{/gray-fg} {white-fg}${CONFIG.socksUser}:***{/white-fg}\n` +
    `{gray-fg}gost restarts{/gray-fg} {white-fg}${gostServerRestarts}{/white-fg}  {gray-fg}err-burst(2m){/gray-fg} ${burst>=5?'{red-fg}':'{white-fg}'}${burst}{/}`
  );
  const col=Math.ceil(pool.length/3);
  const lines=pool.map(s=>{
    const c=sc(s.status);
    const chk = s.lastCheckOk===true?'{green-fg}●{/green-fg}':s.lastCheckOk===false?'{red-fg}●{/red-fg}':'{gray-fg}○{/gray-fg}';
    return `${c}#${String(s.index+1).padStart(2)}{/${c.slice(1)} {gray-fg}:${s.bindPort}{/gray-fg} ${chk}`;
  });
  const c1=lines.slice(0,col),c2=lines.slice(col,col*2),c3=lines.slice(col*2);
  poolBox.setContent(c1.map((l,i)=>l+'  '+(c2[i]||'')+'  '+(c3[i]||'')).join('\n'));
  screen.render();
}

function log(level, msg) {
  const ts=new Date().toISOString().slice(11,19);
  const c={INFO:'{cyan-fg}',OK:'{green-fg}',WARN:'{yellow-fg}',ERROR:'{red-fg}'}[level]||'{white-fg}';
  logBox.log(`{gray-fg}${ts}{/gray-fg} ${c}${level.padStart(5)}{/${c.slice(1)} ${msg}`);
}

setInterval(renderTUI, 500);

// ─── RESOURCE WATCHDOG ────────────────────────────────────────────────────────
function countOpenFds() {
  try { return fs.readdirSync('/proc/self/fd').length; }
  catch { return null; }
}
let lastKnownFds = null;

function startResourceWatchdog() {
  setInterval(() => {
    const fds = countOpenFds();
    lastKnownFds = fds;
    const rssMb = (process.memoryUsage().rss / 1024 / 1024) | 0;
    if (fds !== null && fds > CONFIG.fdWarnThreshold) {
      log('WARN', `Watchdog: ${fds} open FDs (rss=${rssMb}MB) — approaching ulimit, check 'ulimit -n'`);
    }
    if (rssMb > CONFIG.memWarnMb) {
      log('WARN', `Watchdog: RSS ${rssMb}MB (fds=${fds ?? 'n/a'}) — high memory usage`);
    }
  }, CONFIG.resourceWatchdogIntervalMs);
  log('OK', `Resource watchdog started (interval=${CONFIG.resourceWatchdogIntervalMs/1000|0}s, fdWarn=${CONFIG.fdWarnThreshold}, memWarnMb=${CONFIG.memWarnMb})`);
}

// ─── GOST SERVER (host side, single rendezvous process) ─────────────────────
let gostServerProc = null;
let gostServerRestarts = 0;

async function ensureGostBinaryOnHost() {
  if (fs.existsSync(CONFIG.gostBinPath)) {
    log('OK', `gost binary already present at ${CONFIG.gostBinPath}`);
    return;
  }
  log('INFO', `gost binary not found at ${CONFIG.gostBinPath} — downloading v${GOST_VERSION}...`);
  fs.mkdirSync(path.dirname(CONFIG.gostBinPath), { recursive: true });
  const { promisify } = await import('util');
  const execP = promisify(exec);
  const tmpTar = path.join(process.cwd(), 'bin', 'gost.tar.gz');
  let lastErr = null;
  for (const name of GOST_ASSET_CANDIDATES) {
    const url = `${GOST_RELEASE_BASE}/${name}`;
    try {
      await execP(`curl -fsSL -o "${tmpTar}" "${url}"`);
      await execP(`tar -xzf "${tmpTar}" -C "${path.dirname(CONFIG.gostBinPath)}" gost`);
      await execP(`chmod +x "${CONFIG.gostBinPath}"`);
      log('OK', `Downloaded host gost binary from ${name}`);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw new Error(`Failed to download gost binary (tried ${GOST_ASSET_CANDIDATES.join(', ')}): ${lastErr.message}`);
}

function startGostServer() {
  // RTCP uses SOCKS5 BIND on the last forwarding node, so SOCKS5 must be
  // declared explicitly on both ends regardless of the selected transport.
  const tunnelUser = encodeURIComponent(CONFIG.socksUser);
  const tunnelPass = encodeURIComponent(CONFIG.socksPass);
  const args = [`-L=${gostScheme()}://${tunnelUser}:${tunnelPass}@:${CONFIG.rendezvousPort}`];
  log('INFO', `Starting gost rendezvous server (${CONFIG.tunnelTransport}) on :${CONFIG.rendezvousPort}`);
  gostServerProc = spawn(CONFIG.gostBinPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  gostServerProc.stdout.on('data', d => persistGostOutput('gost_server_stdout', d));
  gostServerProc.stderr.on('data', d => persistGostOutput('gost_server_stderr', d));
  gostServerProc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    gostServerRestarts++;
    log('WARN', `gost rendezvous server exited (code=${code}, signal=${signal}) — restart #${gostServerRestarts} in 2s`);
    writeErrorLog('gost_server_exit', { code, signal, restarts: gostServerRestarts });
    setTimeout(startGostServer, 2000);
  });
  gostServerProc.on('error', (err) => {
    log('ERROR', `gost rendezvous server failed to spawn: ${err.message}`);
    writeErrorLog('gost_server_spawn_failed', errorToMeta(err));
  });
  gostServerProc.once('spawn', () => {
    log('OK', `gost rendezvous started via ${CONFIG.tunnelTransport} on 0.0.0.0:${CONFIG.rendezvousPort} (public: ${CONFIG.gostHost}:${CONFIG.rendezvousPort})`);
  });
}

// ─── SANDBOX INIT ─────────────────────────────────────────────────────────────
async function getPublicIp(sandbox) {
  try {
    const r = await sandbox.commands.run(
      'curl -s --max-time 5 https://ifconfig.me || curl -s --max-time 5 https://api.ipify.org',
      { timeoutMs: 8000 }
    );
    return (r.stdout||'').trim() || null;
  } catch { return null; }
}

async function initSlot(slot, pendingStatus = 'starting') {
  slot.status = pendingStatus;
  const apiKey = getApiKeyForSlot(slot.index);
  const apiKeyIndex = getApiKeyIndex(apiKey);
  let phase = 'create';
  let sandbox = null;
  // Count TTL conservatively from before the create request, because E2B's
  // timeout starts remotely before local initialization has completed.
  const sandboxDeadlineAt = Date.now() + CONFIG.sandboxTtlMs;

  try {
    // NOTE: retried only on genuinely transient network/timeout errors
    // (isTransientSdkError). There is a small, accepted risk that a
    // "transient" failure here actually means the create succeeded but the
    // response was lost, producing a duplicate sandbox on retry — this is
    // the same class of risk any at-least-once retry has. reconcileOrphans()
    // is the safety net: any duplicate this causes shows up as untracked and
    // gets killed on the next reconciliation pass.
    sandbox = await withRetry(
      () => Sandbox.create(CONFIG.sandboxTemplate, {
        timeoutMs: CONFIG.sandboxTtlMs,
        apiKey,
        allowInternetAccess: true,
        secure: false,
        requestTimeoutMs: CONFIG.requestTimeoutMs,
      }),
      { label: 'sandbox_create', attempts: 2 } // capped at 2: keep duplicate risk low
    );
    // Track the sandbox as soon as E2B creates it. Otherwise the orphan
    // reconciler can see a valid initializing sandbox before initSlot reaches
    // "ready" and kill it in the middle of a scheduled replacement.
    slot.sandbox = sandbox;
    slot.sandboxId = sandbox.sandboxId;

    phase = 'install_gost';
    const installResult = await sandbox.commands.run(buildGostInstallCmd(), { timeoutMs: 30_000, requestTimeoutMs: CONFIG.requestTimeoutMs });
    if (!/^gost\s/.test((installResult.stdout || '').trim()) && !(installResult.stdout || '').includes('GOST')) {
      // gost -V prints something like "gost 2.12.0 ..." — if we don't see
      // that, install likely failed even though the command "succeeded".
      if (!(installResult.stdout || '').match(/\d+\.\d+\.\d+/)) {
        throw new Error(`gost install did not produce a version string: ${(installResult.stdout||'').slice(0,200)}`);
      }
    }

    phase = 'start_local_socks';
    // These are persistent respawn loops. Using the SDK's background mode is
    // important: wrapping them in `nohup ... &` while calling run() in the
    // foreground can keep the E2B process session open until timeoutMs and
    // intermittently turn an otherwise healthy replacement into an error.
    await sandbox.commands.run(buildStartLocalSocksCmd(), {
      background: true,
      timeoutMs: 0,
      requestTimeoutMs: CONFIG.requestTimeoutMs,
    });

    phase = 'probe_local_socks';
    const probe = await sandbox.commands.run(buildProbeLocalSocksCmd(), { timeoutMs: 20_000, requestTimeoutMs: CONFIG.requestTimeoutMs });
    if (!(probe.stdout || '').includes('UP')) {
      throw new Error(`[#${slot.index+1}] local gost socks5 did not come up in time`);
    }

    phase = 'start_reverse_tunnel';
    if (!(await waitForBindPortRelease(slot.bindPort))) {
      throw new Error(`[#${slot.index+1}] bind port ${slot.bindPort} is still owned by a previous tunnel after ${CONFIG.portReleaseTimeoutMs}ms`);
    }
    await sandbox.commands.run(buildStartReverseTunnelCmd(slot.bindPort), {
      background: true,
      timeoutMs: 0,
      requestTimeoutMs: CONFIG.requestTimeoutMs,
    });

    phase = 'probe_tunnel';
    const deadline = Date.now() + 15_000;
    let tunnelUp = false;
    while (Date.now() < deadline) {
      if (await checkSocks5Reachable(slot.bindPort, 3000)) { tunnelUp = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!tunnelUp) throw new Error(`[#${slot.index+1}] reverse tunnel bind port ${slot.bindPort} not reachable on host within 15s`);

    phase = 'resolve_public_ip';
    const ip = await getPublicIp(sandbox);

    slot.sandbox   = sandbox;
    slot.sandboxId = sandbox.sandboxId;
    slot.publicIp  = ip;
    slot.createdAt = sandboxDeadlineAt - CONFIG.sandboxTtlMs;
    slot.expiresAt = sandboxDeadlineAt;
    slot.status    = 'ready';
    slot.lastErrorAt = null;
    slot.nextRetryAt = null;
    slot.backoffMs   = 0;
    slot.keepaliveMisses = 0;
    slot.socksMisses     = 0;
    slot.lastCheckOk     = true;
    slot.lastCheckAt     = Date.now();

    log('OK', `[#${slot.index+1}] Ready {yellow-fg}${sandbox.sandboxId}{/yellow-fg} egress-ip={white-fg}${ip||'?'}{/white-fg} socks5={white-fg}${CONFIG.gostHost}:${slot.bindPort}{/white-fg}`);
  } catch (error) {
    writeErrorLog('sandbox_init_failed', {
      slotIndex: slot.index, slotNumber: slot.index + 1, apiKeyIndex,
      apiKeyMasked: maskApiKey(apiKey), sandboxId: sandbox?.sandboxId || null,
      phase, ...errorToMeta(error),
    });
    recordSlotError(slot.index, `init_failed:${phase}`);
    // v7.2: "bind port still owned" at this phase almost always means some
    // OTHER, untracked sandbox on this API key is still alive and actively
    // re-claiming the port via its own tunnel respawn loop (see the v7.2
    // note above reconcileOrphans) — not that release is merely slow. Kick
    // off a targeted sweep for just this API key right away so the orphan
    // has a chance to be gone before the next retry of this same slot,
    // rather than waiting up to reconcileIntervalMs (default 300s).
    if (/still owned by a previous tunnel/.test(error?.message || '')) {
      triggerTargetedReconcile(apiKey, `slot #${slot.index+1} bind port ${slot.bindPort} conflict`);
    }
    if (sandbox) {
      await withRetry(
        () => sandbox.kill({ requestTimeoutMs: CONFIG.requestTimeoutMs }),
        { label: 'sandbox_orphan_kill' }
      ).catch(killErr => {
        writeErrorLog('sandbox_orphan_kill_failed', { slotIndex: slot.index, sandboxId: sandbox.sandboxId, phase, ...errorToMeta(killErr) });
      });
      if (slot.sandbox === sandbox) {
        slot.sandbox = null;
        slot.sandboxId = null;
        slot.publicIp = null;
      }
      await waitForBindPortRelease(slot.bindPort);
    }
    throw error;
  }
}

// v7.2.1 fix: recreateSlot() fires for many routine, healthy reasons —
// scheduled TTL renewal, the dashboard "Renew" button, the nightly 1AM
// reset, a manual per-slot restart — none of which are faults. The error-
// burst detector must only count recreates triggered by an actual detected
// problem (keepalive failing, tunnel unreachable), or a pool's normal
// synchronized TTL rollover (all sandboxes created in the same startup
// batch expire within the same few minutes) gets misreported as "48 slot
// errors in the last 2 minutes" when nothing is actually wrong.
function isFaultRecreateReason(reason) {
  return /^keepalive fail|^tunnel unreachable/.test(reason || '');
}

async function recreateSlot(slot, reason) {
  if (slot.status === 'recreating') return;
  log('WARN', `[#${slot.index+1}] Recreating — ${reason}`);
  slot.status = 'recreating';
  slot.recreations++;
  if (isFaultRecreateReason(reason)) recordSlotError(slot.index, reason);
  const old = slot.sandbox;
  slot.sandbox = null; slot.sandboxId = null; slot.publicIp = null;
  let lastError = null;
  try {
    // A mux BIND owns the public listener for the lifetime of the old tunnel.
    // It must be gone before a replacement can bind the same fixed slot port.
    //
    // v7.1: kill() is now retried against transient network/timeout errors
    // (see isTransientSdkError). Previously a single "fetch failed" here —
    // which does NOT mean the sandbox is confirmed dead, only that the kill
    // request itself may never have reached E2B — was treated the same as a
    // real "not found" response, and the code moved straight on to waiting
    // for the bind port to free up. If the old tunnel was, in fact, still
    // alive, that wait was always going to time out. Retrying the kill first
    // gives it a real chance to actually reach E2B before we start the
    // port-release countdown.
    let oldKillError = null;
    let oldKillWasNotFound = false;
    if (old) {
      try {
        await withRetry(
          () => old.kill({ requestTimeoutMs: CONFIG.requestTimeoutMs }),
          { label: 'sandbox_recreate_kill' }
        );
      } catch (err) {
        oldKillError = err;
        oldKillWasNotFound = isNotFoundSdkError(err);
      }
    }
    if (!(await waitForBindPortRelease(slot.bindPort))) {
      if (oldKillError) {
        writeErrorLog('sandbox_recreate_kill_failed', {
          slotIndex: slot.index, sandboxId: old?.sandboxId, reason,
          notFound: oldKillWasNotFound, ...errorToMeta(oldKillError),
        });
      }
      throw new Error(`[#${slot.index+1}] old tunnel did not release bind port ${slot.bindPort}`);
    }
    if (oldKillError && !oldKillWasNotFound) {
      // Kill never got a confirmed response from E2B even after retries —
      // the port happened to free up anyway (old tunnel likely died on its
      // own), so it's safe to continue, but this is worth flagging distinctly
      // from the normal "already gone" case since it may indicate a network
      // issue between this host and E2B rather than a genuinely expired sandbox.
      log('WARN', `[#${slot.index+1}] Old sandbox kill unconfirmed after retries (network?); bind port released anyway, continuing replacement`);
    } else if (oldKillError && oldKillWasNotFound) {
      // An already-expired E2B sandbox commonly returns not-found on kill.
      // If its tunnel/port is gone, replacement can continue normally.
      log('WARN', `[#${slot.index+1}] Old sandbox was already unavailable; bind port released, continuing replacement`);
    } else {
      log('INFO', `[#${slot.index+1}] Old sandbox stopped; creating replacement`);
    }
    for (let attempt = 1; attempt <= CONFIG.replacementMaxAttempts; attempt++) {
      try {
        await initSlot(slot, 'recreating');
        return;
      } catch (err) {
        lastError = err;
        if (attempt >= CONFIG.replacementMaxAttempts) break;
        slot.status = 'recreating';
        log('WARN', `[#${slot.index+1}] Replacement attempt ${attempt}/${CONFIG.replacementMaxAttempts} failed: ${err.message}; retrying in ${CONFIG.replacementRetryDelayMs/1000}s`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.replacementRetryDelayMs));
      }
    }
    throw lastError || new Error(`[#${slot.index+1}] replacement failed`);
  } catch (err) {
    slot.status = 'error';
    slot.lastErrorAt = Date.now();
    slot.backoffMs = Math.min(
      CONFIG.errorRecoveryMaxBackoffMs,
      Math.max(CONFIG.errorRecoveryInitialBackoffMs, (slot.backoffMs || CONFIG.errorRecoveryInitialBackoffMs) * 2)
    );
    slot.nextRetryAt = Date.now() + slot.backoffMs;
    recordSlotError(slot.index, `recreate_failed:${err.message}`);
    log('ERROR', `[#${slot.index+1}] ${err.message} (retry in ${(slot.backoffMs/1000)|0}s)`);
  }
}

async function initPool() {
  const concurrency = CONFIG.sandboxConcurrency;
  const batchDelayMs = CONFIG.sandboxBatchDelayMs;
  log('INFO', `Starting ${TOTAL_SANDBOXES} sandboxes in batches (concurrency=${concurrency})...`);
  for (let i = 0; i < pool.length; i += concurrency) {
    const batch = pool.slice(i, i + concurrency);
    await Promise.all(batch.map(slot =>
      initSlot(slot).catch(err => {
        slot.status = 'error';
        slot.lastErrorAt = Date.now();
        slot.backoffMs   = CONFIG.errorRecoveryInitialBackoffMs;
        slot.nextRetryAt = Date.now() + slot.backoffMs;
        log('ERROR', `[#${slot.index+1}] Init: ${err.message} (queued for recovery)`);
      })
    ));
    if (i + concurrency < pool.length) await new Promise(r => setTimeout(r, batchDelayMs));
  }
  const ready = pool.filter(s=>s.status==='ready').length;
  log('OK', `Pool init done — {green-fg}${ready}{/green-fg}/${TOTAL_SANDBOXES} ready`);
}

// ─── KEEPALIVE (sandbox liveness + tunnel reachability) ─────────────────────
function startKeepalive() {
  setInterval(() => {
    for (const slot of pool) {
      if (!slot.sandbox || slot.status !== 'ready') continue;
      if (slot.expiresAt - Date.now() <= CONFIG.sandboxRenewBeforeMs) {
        enqueueUnplannedRecreate(slot, `TTL < ${Math.ceil(CONFIG.sandboxRenewBeforeMs/60000)}min`);
        continue;
      }

      // 1) Sandbox-process liveness (same as before).
      slot.sandbox.commands.run('echo k', { timeoutMs: 8000 })
        .then(() => { slot.keepaliveMisses = 0; })
        .catch(() => {
          slot.keepaliveMisses = (slot.keepaliveMisses || 0) + 1;
          if (slot.keepaliveMisses >= CONFIG.keepaliveMissThreshold) {
            enqueueUnplannedRecreate(slot, `keepalive fail x${slot.keepaliveMisses}`);
          } else {
            log('WARN', `[#${slot.index+1}] keepalive miss ${slot.keepaliveMisses}/${CONFIG.keepaliveMissThreshold}`);
          }
        });

      // 2) End-to-end tunnel reachability on this host's bind port — this
      //    is what catches "sandbox alive but gost tunnel died" (replaces
      //    the old WS-bridge circuit breaker).
      checkSocks5Reachable(slot.bindPort, 4000).then(ok => {
        slot.lastCheckOk = ok;
        slot.lastCheckAt = Date.now();
        if (ok) { slot.socksMisses = 0; return; }
        slot.socksMisses = (slot.socksMisses || 0) + 1;
        gStats.errors++; slot.errors++;
        if (slot.socksMisses >= CONFIG.keepaliveMissThreshold) {
          log('WARN', `[#${slot.index+1}] tunnel unreachable x${slot.socksMisses} on :${slot.bindPort}`);
          enqueueUnplannedRecreate(slot, `tunnel unreachable x${slot.socksMisses}`);
        }
      });
    }
  }, CONFIG.keepaliveMs);
}

// ─── ERROR RECOVERY ──────────────────────────────────────────────────────────
async function killSandboxById(sandboxId, apiKey) {
  if (!sandboxId) return;
  try {
    await withRetry(
      () => Sandbox.kill(sandboxId, { apiKey, requestTimeoutMs: CONFIG.requestTimeoutMs }),
      { label: 'sandbox_recover_kill' }
    );
    log('OK', `Killed orphan sandbox ${sandboxId}`);
  } catch (err) {
    writeErrorLog('sandbox_recover_kill_failed', { sandboxId, apiKeyMasked: maskApiKey(apiKey), ...errorToMeta(err) });
    log('WARN', `Kill ${sandboxId} failed (may already be gone): ${err?.message||err}`);
  }
}

async function recoverSlot(slot) {
  if (slot.recoveryInFlight) return;
  if (slot.nextRetryAt && Date.now() < slot.nextRetryAt) return;
  slot.recoveryInFlight = true;
  const prevSandboxId = slot.sandboxId;
  const apiKey = getApiKeyForSlot(slot.index);
  log('INFO', `[#${slot.index+1}] Error recovery: deleting sandbox ${prevSandboxId||'(none)'} & replacing slot`);
  if (prevSandboxId) await killSandboxById(prevSandboxId, apiKey);
  try {
    await queueRecreate(slot, 'error recovery');
  } catch (err) {
    log('ERROR', `[#${slot.index+1}] Recovery failed: ${err?.message||err}`);
  } finally {
    slot.recoveryInFlight = false;
  }
}

function startErrorRecovery() {
  if (!CONFIG.errorRecoveryEnabled) {
    log('WARN', 'Error recovery disabled via ERROR_RECOVERY_ENABLED=false');
    return;
  }
  setInterval(async () => {
    const errored = pool.filter(s => s.status === 'error' && !s.recoveryInFlight);
    if (!errored.length) return;
    log('INFO', `Error recovery: ${errored.length} slot(s) in error state, checking retry eligibility...`);
    const now = Date.now();
    const eligible = errored.filter(s => !s.nextRetryAt || now >= s.nextRetryAt);
    if (!eligible.length) return;
    const batch = eligible.slice(0, CONFIG.errorRecoveryConcurrency);
    await Promise.all(batch.map(slot => recoverSlot(slot).catch(err => {
      log('ERROR', `[#${slot.index+1}] recoverSlot threw: ${err?.message||err}`);
      slot.recoveryInFlight = false;
    })));
  }, CONFIG.errorRecoveryIntervalMs);
  log('OK', `Error recovery loop started (interval=${CONFIG.errorRecoveryIntervalMs/1000|0}s, concurrency=${CONFIG.errorRecoveryConcurrency})`);
}

// ─── ORPHAN RECONCILIATION ────────────────────────────────────────────────────
//
// v7.2 note: a sandbox's gost reverse-tunnel respawn loop
// (`while true; do gost -L=rtcp://:<bindPort>/... ; sleep 2; done`) runs
// entirely independently of this Node process's lifecycle. If this process
// restarts and its startup deleteAllSandboxes() call fails to kill an old
// sandbox for a given API key (the same class of transient network error
// documented in the v7.1 note above), that sandbox keeps re-dialing the
// freshly-spawned gost rendezvous server every 2 seconds and keeps
// RE-CLAIMING its bindPort — forever, not just slowly releasing it. That
// showed up as "bind port ... still owned by a previous tunnel" during
// initPool() itself (not recreateSlot), where there is no "old" sandbox
// object to retry-kill because this is the very first attempt for that
// slot. No portReleaseTimeoutMs value fixes this, because the port isn't
// draining — it's being actively re-occupied by a sandbox that is genuinely
// still alive on E2B. The only real fix is finding and killing that orphan.
// Previously reconcileOrphans() only ran on a 300s interval with no eager
// first pass, so a leftover orphan from a bad restart could block pool
// startup for minutes. Two changes below address this: (1) the per-key
// sweep is now reusable and can be triggered reactively the moment a slot
// hits this exact failure, not just on the periodic timer; (2) an eager
// first reconcile pass now runs shortly after startup instead of waiting
// for the first full interval.

// Per-key in-flight guard: several slots on the same API key can hit a bind-
// port conflict within milliseconds of each other (they're created in the
// same batch); without this guard each one would kick off its own redundant
// list+kill sweep for that key.
const reconcileInFlightKeys = new Set();

async function reconcileApiKey(apiKey) {
  const keyLabel = maskApiKey(apiKey);
  if (reconcileInFlightKeys.has(apiKey)) return;
  reconcileInFlightKeys.add(apiKey);
  try {
    let items = [];
    try {
      items = await withRetry(
        () => Sandbox.list({ apiKey, query: { state: 'running' }, requestTimeoutMs: CONFIG.requestTimeoutMs }),
        { label: 'reconcile_list' }
      );
    } catch (err) {
      writeErrorLog('reconcile_list_failed', { apiKeyMasked: keyLabel, ...errorToMeta(err) });
      log('WARN', `Reconcile: list failed for key ${keyLabel}: ${err?.message||err}`);
      return;
    }

    const trackedIds = new Set(pool.filter(s => s.sandboxId).map(s => s.sandboxId));
    const orphans = items.filter(item => !trackedIds.has(item.sandboxId));
    if (!orphans.length) return;

    log('WARN', `Reconcile: ${orphans.length} untracked sandbox(es) running for key ${keyLabel} (${items.length} total vs pool's ${trackedIds.size} tracked) — killing`);
    await mapLimit(orphans, CONFIG.sandboxConcurrency, item =>
      withRetry(
        () => Sandbox.kill(item.sandboxId, { apiKey, requestTimeoutMs: CONFIG.requestTimeoutMs }),
        { label: 'reconcile_kill' }
      )
        .then(() => log('OK', `Reconcile: killed orphan ${item.sandboxId}`))
        .catch(err => writeErrorLog('reconcile_kill_failed', { sandboxId: item.sandboxId, apiKeyMasked: keyLabel, ...errorToMeta(err) }))
    );
  } finally {
    reconcileInFlightKeys.delete(apiKey);
  }
}

async function reconcileOrphans() {
  const keys = (CONFIG.e2bApiKeys && CONFIG.e2bApiKeys.length) ? CONFIG.e2bApiKeys : (CONFIG.e2bApiKey ? [CONFIG.e2bApiKey] : []);
  if (!keys.length) return;

  // Never reconcile against a moving pool snapshot. A newly created sandbox
  // can otherwise be mistaken for an orphan while it is still initializing.
  if (recreateInFlight > 0 || pool.some(s => ['starting', 'recreating'].includes(s.status))) return;

  for (const apiKey of keys) {
    await reconcileApiKey(apiKey);
  }
}

// Reactive, targeted sweep: fired the moment a slot fails because its bind
// port is still held by something. Fire-and-forget on purpose — it must
// not block the failing slot's own error handling/retry path. The pool-
// snapshot guard from reconcileOrphans() is intentionally NOT applied here:
// this is scoped to a single API key by sandboxId, so a concurrently
// 'starting' slot on a different key can't be mistaken for the orphan.
function triggerTargetedReconcile(apiKey, reason) {
  if (!apiKey) return;
  log('INFO', `Reconcile: triggering targeted sweep for key ${maskApiKey(apiKey)} (${reason})`);
  reconcileApiKey(apiKey).catch(err => log('WARN', `Targeted reconcile error: ${err?.message||err}`));
}

function startReconciliation() {
  // Eager first pass shortly after startup, instead of waiting a full
  // reconcileIntervalMs (default 300s) for the first sweep to ever run.
  setTimeout(() => {
    reconcileOrphans().catch(err => log('ERROR', `Reconcile error: ${err?.message||err}`));
  }, Math.min(CONFIG.reconcileIntervalMs, CONFIG.reconcileFirstRunDelayMs));
  setInterval(() => {
    reconcileOrphans().catch(err => log('ERROR', `Reconcile error: ${err?.message||err}`));
  }, CONFIG.reconcileIntervalMs);
  log('OK', `Orphan reconciliation loop started (interval=${CONFIG.reconcileIntervalMs/1000|0}s, first pass in ${Math.min(CONFIG.reconcileIntervalMs, CONFIG.reconcileFirstRunDelayMs)/1000|0}s)`);
}

// ─── RENEW / MANUAL RECREATE ─────────────────────────────────────────────────
async function renewAllSlots() {
  resetErrorLog();
  log('INFO', 'Manual renew requested — recreating all sandboxes...');
  const concurrency = CONFIG.sandboxConcurrency;
  const delayMs = CONFIG.sandboxBatchDelayMs;
  for (let i = 0; i < pool.length; i += concurrency) {
    const batch = pool.slice(i, i + concurrency);
    await Promise.all(batch.map(slot =>
      queueRecreate(slot, 'manual renew').catch(err => log('WARN', `[#${slot.index+1}] renew err: ${err?.message||err}`))
    ));
    if (i + concurrency < pool.length) await new Promise(r => setTimeout(r, delayMs));
  }
  log('OK', 'Manual renew complete.');
}

// ─── DAILY RESET AT 1AM ──────────────────────────────────────────────────────
async function dailyResetAllSlots() {
  resetErrorLog();
  log('INFO', 'Daily 1AM reset — replacing each old sandbox through the recreate queue...');
  for (let i = 0; i < pool.length; i += CONFIG.sandboxConcurrency) {
    const batch = pool.slice(i, i + CONFIG.sandboxConcurrency);
    await Promise.all(batch.map(slot =>
      queueRecreate(slot, 'daily reset').catch(err =>
        log('ERROR', `[#${slot.index+1}] Daily reset: ${err.message}`)
      )
    ));
    if (i + CONFIG.sandboxConcurrency < pool.length)
      await new Promise(r => setTimeout(r, CONFIG.sandboxBatchDelayMs));
  }
  const ready = pool.filter(s => s.status === 'ready').length;
  log('OK', `Daily reset complete — {green-fg}${ready}{/green-fg}/${TOTAL_SANDBOXES} ready`);
}

function startDailyReset() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(1, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const msUntilReset = target - now;
  log('INFO', `Daily reset scheduled at ${target.toLocaleString()} (in ${fmtDur(msUntilReset)})`);
  setTimeout(() => {
    dailyResetAllSlots().catch(err => log('ERROR', `Daily reset error: ${err.message}`));
    setInterval(() => {
      dailyResetAllSlots().catch(err => log('ERROR', `Daily reset error: ${err.message}`));
    }, 24 * 60 * 60 * 1000);
  }, msUntilReset);
}

// ─── SINGLE SLOT RESTART ──────────────────────────────────────────────────────
async function restartSlot(index) {
  const slot = pool[index];
  if (!slot) { log('ERROR', `Restart: slot #${index+1} not found`); return; }
  if (slot.status === 'recreating') { log('WARN', `[#${index+1}] Already recreating, skipping`); return; }

  await queueRecreate(slot, 'manual slot restart');
}

// ─── SHUTDOWN ────────────────────────────────────────────────────────────────
let shuttingDown = false;
let dashServer;

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('WARN', `Shutting down (${reason}) — killing gost server & all sandboxes...`);
  try { gostServerProc?.kill(); } catch {}
  dashServer?.close();
  await Promise.allSettled(pool.filter(s=>s.sandbox).map(s => s.sandbox.kill().catch(err => { log('WARN', `Kill pool sandbox error: ${err?.message||err}`); })));

  if (CONFIG.e2bApiKey || (CONFIG.e2bApiKeys && CONFIG.e2bApiKeys.length)) {
    try {
      log('INFO', 'Calling deleteAllSandboxes helper...');
      const keys = (CONFIG.e2bApiKeys && CONFIG.e2bApiKeys.length) ? CONFIG.e2bApiKeys : (CONFIG.e2bApiKey ? [CONFIG.e2bApiKey] : []);
      await deleteAllSandboxes(keys);
      log('INFO', 'deleteAllSandboxes completed.');
    } catch (err) {
      log('WARN', `deleteAllSandboxes error: ${err?.message||err}`);
    }
  }

  log('OK', 'Shutdown complete — all kill attempts finished. Bye!');
  process.exit(0);
}

// ─── DASHBOARD HTML ──────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>E2B GOST Proxy Dashboard</title>
<style>
:root{--bg:#0d1117;--sf:#161b22;--bd:#30363d;--tx:#c9d1d9;--mu:#8b949e;
  --gr:#3fb950;--yw:#d29922;--rd:#f85149;--bl:#58a6ff;--pu:#bc8cff;--cy:#39d0d0}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font-family:'Segoe UI',system-ui,monospace;font-size:14px}
header{background:var(--sf);border-bottom:1px solid var(--bd);padding:14px 24px;
  display:flex;align-items:center;gap:16px}
header h1{font-size:18px;font-weight:700;color:var(--cy)}
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;
  background:rgba(63,185,80,.15);color:var(--gr);border:1px solid rgba(63,185,80,.3)}
.uptime{margin-left:auto;color:var(--mu);font-size:12px}
.gcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:20px 24px 8px}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:14px 16px}
.card .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--mu)}
.card .val{font-size:26px;font-weight:700;margin-top:4px}
.vg{color:var(--gr)}.vr{color:var(--rd)}.vb{color:var(--bl)}.vc{color:var(--cy)}.vy{color:var(--yw)}
.stitle{padding:18px 24px 8px;font-size:13px;font-weight:600;color:var(--mu);
  text-transform:uppercase;letter-spacing:.8px}
.sgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:12px;padding:0 24px 24px}
.scard{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:14px 16px}
.scard.ready      {border-left:3px solid var(--gr)}
.scard.starting   {border-left:3px solid var(--yw)}
.scard.recreating {border-left:3px solid var(--pu)}
.scard.error      {border-left:3px solid var(--rd)}
.sh{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.si{font-size:11px;font-weight:700;color:var(--mu);width:26px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot-ready{background:var(--gr);box-shadow:0 0 6px var(--gr)}
.dot-starting,.dot-recreating{background:var(--yw);animation:pulse 1s infinite}
.dot-recreating{background:var(--pu)}
.dot-error{background:var(--rd)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.sid{font-family:monospace;font-size:11px;color:var(--bl);flex:1;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.ssl{font-size:11px;font-weight:600;margin-left:auto}
.sl-ready{color:var(--gr)}.sl-starting,.sl-recreating{color:var(--yw)}.sl-error{color:var(--rd)}
.sl-recreating{color:var(--pu)}
.rst-btn{margin-left:4px;padding:2px 6px;border-radius:4px;border:none;background:var(--rd);color:#fff;font-weight:700;cursor:pointer;font-size:11px;line-height:1.4;flex-shrink:0}
.rst-btn:hover{opacity:.8}
.ssocks{font-family:monospace;font-size:13px;color:var(--cy);margin-bottom:8px}
.srows{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px}
.srow{display:flex;justify-content:space-between;font-size:12px}
.srow .k{color:var(--mu)}.srow .v{font-weight:600}
.pbw{background:var(--bd);border-radius:4px;height:4px;margin-top:10px;overflow:hidden}
.pb{height:100%;border-radius:4px;background:var(--gr);transition:width .5s}
.pb.warn{background:var(--yw)}.pb.crit{background:var(--rd)}
.ttl{font-size:10px;color:var(--mu);margin-top:3px;text-align:right}
footer{padding:12px 24px;color:var(--mu);font-size:11px;border-top:1px solid var(--bd)}
.dlive{display:inline-block;width:6px;height:6px;border-radius:50%;
  background:var(--gr);margin-right:4px;animation:pulse .8s infinite}
.netbanner{display:none;margin:0 24px 12px;padding:10px 14px;border-radius:8px;
  background:rgba(248,81,73,.12);border:1px solid rgba(248,81,73,.35);color:var(--rd);
  font-size:12px;font-weight:600}
</style>
</head>
<body>
<header>
  <h1>⬡ E2B GOST Dashboard</h1>
  <span class="badge" id="poolBadge">connecting…</span>
  <button id="renewBtn" style="margin-left:8px;padding:6px 10px;border-radius:8px;border:none;background:var(--pu);color:#0d1117;font-weight:700;cursor:pointer">Renew</button>
  <button id="reloadBtn" style="padding:6px 10px;border-radius:8px;border:none;background:var(--yw);color:#0d1117;font-weight:700;cursor:pointer">Reload</button>
  <span class="uptime" id="uptime">—</span>
</header>
<div class="netbanner" id="netBanner"></div>
<div class="gcards">
  <div class="card"><div class="lbl">Ready</div><div class="val vg" id="g-ready">—</div></div>
  <div class="card"><div class="lbl">Starting</div><div class="val vy" id="g-starting">—</div></div>
  <div class="card"><div class="lbl">Error</div><div class="val vr" id="g-error">—</div></div>
  <div class="card"><div class="lbl">Recreate Q</div><div class="val vb" id="g-rq">—</div></div>
  <div class="card"><div class="lbl">FDs / RSS</div><div class="val vc" id="g-res">—</div></div>
  <div class="card"><div class="lbl">gost restarts</div><div class="val vy" id="g-gostrestarts">—</div></div>
</div>
<div class="stitle">Sandboxes — rendezvous <span id="rv-addr" style="color:var(--cy)"></span></div>
<div class="sgrid" id="sgrid"></div>
<footer><span class="dlive"></span>Live · SSE · gost reverse-tunnel mode (traffic no longer transits this process, so no byte/connection counters are shown — only tunnel reachability)</footer>
<script>
const fd=ms=>{const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);return h>0?\`\${h}h \${m%60}m\`:m>0?\`\${m}m \${s%60}s\`:\`\${s}s\`};
const g=id=>document.getElementById(id);
const grid=g('sgrid');const cards={};
function render(s){
  const sc=s.status;
  const pct=s.expiresIn>0?Math.round(s.expiresIn/(55*60*1000)*100):0;
  const bc=pct<10?'crit':pct<25?'warn':'';
  let el=cards[s.index];
  if(!el){
    el=document.createElement('div');el.className='scard';
    el.innerHTML=\`<div class="sh">
      <span class="si">#\${s.index+1}</span>
      <span class="dot" id="dt-\${s.index}"></span>
      <span class="sid" id="id-\${s.index}">—</span>
      <span class="ssl" id="st-\${s.index}"></span>
      <button class="rst-btn" id="rst-\${s.index}" title="Restart this sandbox">↻</button></div>
    <div class="ssocks" id="sk-\${s.index}">—</div>
    <div class="srows">
      <div class="srow"><span class="k">Egress IP</span><span class="v" id="ip-\${s.index}">—</span></div>
      <div class="srow"><span class="k">Reachable</span><span class="v" id="ck-\${s.index}">—</span></div>
      <div class="srow"><span class="k">Errors</span><span class="v" id="er-\${s.index}">—</span></div>
      <div class="srow"><span class="k">Uptime</span><span class="v" id="ut-\${s.index}">—</span></div>
      <div class="srow"><span class="k">Recreations</span><span class="v" id="rc-\${s.index}">—</span></div>
    </div>
    <div class="pbw"><div class="pb" id="pb-\${s.index}"></div></div>
    <div class="ttl" id="ttl-\${s.index}">—</div>\`;
    grid.appendChild(el);cards[s.index]=el;
    document.getElementById('rst-'+s.index).addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Restart sandbox #'+(s.index+1)+'? Old sandbox will be deleted and a new one created.')) return;
      try {
        const r = await fetch('/api/restart-slot/'+s.index, { method: 'POST' });
        if (r.ok) alert('Restart started for #'+(s.index+1)); else alert('Restart request failed');
      } catch (e) { alert('Restart error: ' + (e.message || e)); }
    });
  }
  el.className='scard '+sc;
  g('dt-'+s.index).className='dot dot-'+sc;
  g('id-'+s.index).textContent=s.sandboxId||'—';
  const st=g('st-'+s.index);st.textContent=sc.toUpperCase();st.className='ssl sl-'+sc;
  g('sk-'+s.index).textContent='socks5://'+s.socksAddr;
  g('ip-'+s.index).textContent=s.publicIp||'—';
  const ck=g('ck-'+s.index);
  ck.textContent = s.lastCheckOk===true?'OK':s.lastCheckOk===false?'FAIL':'—';
  ck.style.color = s.lastCheckOk===true?'var(--gr)':s.lastCheckOk===false?'var(--rd)':'var(--mu)';
  g('er-'+s.index).textContent=s.errors;
  g('ut-'+s.index).textContent=s.uptime>0?fd(s.uptime):'—';
  g('rc-'+s.index).textContent=s.recreations;
  const pb=g('pb-'+s.index);pb.style.width=pct+'%';pb.className='pb '+bc;
  g('ttl-'+s.index).textContent=s.expiresIn>0?'Expires in '+fd(s.expiresIn):'—';
}
const es=new EventSource('/events');
es.onmessage=e=>{
  const d=JSON.parse(e.data);
  g('g-ready').textContent=d.ready; g('g-starting').textContent=d.starting; g('g-error').textContent=d.errored;
  g('g-rq').textContent=d.recreateQueueLen+' ('+d.recreateInFlight+')';
  g('g-res').textContent=(d.openFds??'n/a')+' / '+d.rssMb+'MB';
  g('g-gostrestarts').textContent=d.gostServerRestarts ?? 0;
  g('uptime').textContent='uptime: '+fd(d.uptime);
  g('rv-addr').textContent=d.gostHost+':'+d.rendezvousPort;
  g('poolBadge').textContent=d.ready+' / '+d.total+' ready';
  const banner=g('netBanner');
  if((d.recentErrorBurst||0)>=5){
    banner.style.display='block';
    banner.textContent='⚠ '+d.recentErrorBurst+' slot errors in the last 2 minutes — likely a single network/API blip between this host and E2B, not '+d.recentErrorBurst+' independent sandbox faults.';
  } else {
    banner.style.display='none';
  }
  d.sandboxes.forEach(render);
};
es.onerror=()=>g('poolBadge').textContent='disconnected';
const _renewBtn = document.getElementById('renewBtn');
if (_renewBtn) _renewBtn.addEventListener('click', async ()=>{
  if (!confirm('Recreate all sandboxes? This will recreate VMs and may take several minutes. Continue?')) return;
  try {
    const r = await fetch('/api/renew', { method: 'POST' });
    if (r.ok) alert('Renew started'); else alert('Renew request failed');
  } catch (e) { alert('Renew request error: ' + (e.message || e)); }
});
const _reloadBtn = document.getElementById('reloadBtn');
if (_reloadBtn) _reloadBtn.addEventListener('click', async ()=>{
  if (!confirm('Reload proxy server via pm2? Tunnels will be interrupted briefly.')) return;
  try {
    const r = await fetch('/api/reload', { method: 'POST' });
    if (r.ok) alert('Reload started'); else alert('Reload request failed');
  } catch (e) { alert('Reload request error: ' + (e.message || e)); }
});
</script>
</body>
</html>`;

// ─── HTTP DASHBOARD ───────────────────────────────────────────────────────────
function startDashboard() {
  dashServer = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type':'text/event-stream','Cache-Control':'no-cache',
        'Connection':'keep-alive','Access-Control-Allow-Origin':'*'
      });
      res.write(':ok\n\n');
      sseClients.add(res);
      res.write(`data: ${JSON.stringify(buildPayload())}\n\n`);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.url === '/api/stats') {
      res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify(buildPayload(),null,2)); return;
    }
    if (req.url === '/api/renew' && req.method === 'POST') {
      res.writeHead(202,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ status: 'started' }));
      renewAllSlots().catch(err => log('WARN', `renew error: ${err?.message||err}`));
      return;
    }
    if (req.url === '/api/reload' && req.method === 'POST') {
      res.writeHead(202,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ status: 'started' }));
      log('INFO', 'Reload requested — executing pm2 reload proxy...');
      exec('pm2 reload proxy', (err, stdout, stderr) => {
        if (err) log('ERROR', `pm2 reload failed: ${err.message}`);
        else log('OK', `pm2 reload: ${stdout.trim()}`);
      });
      return;
    }
    if (req.url.startsWith('/api/restart-slot/') && req.method === 'POST') {
      const idx = parseInt(req.url.split('/').pop(), 10);
      res.writeHead(202,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ status: 'started', slotIndex: idx }));
      restartSlot(idx).catch(err => log('WARN', `restart slot #${idx+1} error: ${err?.message||err}`));
      return;
    }
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
    res.end(DASHBOARD_HTML);
  });
  dashServer.listen(CONFIG.dashPort,'0.0.0.0',()=>
    log('OK',`Dashboard {white-fg}http://0.0.0.0:${CONFIG.dashPort}{/white-fg}`)
  );
  dashServer.on('error',e=>log('ERROR',`Dashboard: ${e.message}`));
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  resetErrorLog();
  renderTUI();
  startDashboard();

  // Validate before starting any external process or sandbox.
  gostScheme();
  if (CONFIG.sandboxRenewBeforeMs <= 0 || CONFIG.sandboxRenewBeforeMs >= CONFIG.sandboxTtlMs) {
    throw new Error('E2B_RENEW_BEFORE_MINUTES must be greater than 0 and lower than E2B_SANDBOX_TIMEOUT_MINUTES');
  }
  if (CONFIG.replacementMaxAttempts < 1) {
    throw new Error('REPLACEMENT_MAX_ATTEMPTS must be at least 1');
  }

  if (!process.env.GOST_SOCKS_PASS) {
    log('WARN', `GOST_SOCKS_PASS not set in env — generated a random password for this run: ${CONFIG.socksUser}:${CONFIG.socksPass} (set GOST_SOCKS_PASS to keep it stable across restarts)`);
  }

  await ensureGostBinaryOnHost();
  startGostServer();

  const startupApiKeys = (CONFIG.e2bApiKeys && CONFIG.e2bApiKeys.length)
    ? CONFIG.e2bApiKeys
    : (CONFIG.e2bApiKey ? [CONFIG.e2bApiKey] : []);
  if (startupApiKeys.length) {
    log('INFO', 'Startup cleanup: deleting all running sandboxes for configured API key(s)...');
    await deleteAllSandboxes(startupApiKeys);
    log('OK', 'Startup cleanup complete.');
  }
  await initPool();
  startKeepalive();
  startErrorRecovery();
  startReconciliation();
  startResourceWatchdog();
  startDailyReset();
  process.on('SIGINT',            () => shutdown('SIGINT'));
  process.on('SIGTERM',           () => shutdown('SIGTERM'));
  process.on('uncaughtException', e  => log('ERROR',`Uncaught: ${e.message}`));
  process.on('unhandledRejection',e  => log('WARN', `Unhandled: ${e}`));
}

main();
