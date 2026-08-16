#!/usr/bin/env node
// One-off Beam sandbox + GOST test. Ctrl+C always terminates the sandbox.
// Usage: BEAM_TEST_KEY='workspace-id|token' npm run test:beam-gost
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { beamOpts, Image, Sandbox } from '@beamcloud/beam-js';

try { process.loadEnvFile('.env'); } catch {}
const TEST_PORT = 39998;
const key = String(process.env.BEAM_TEST_KEY || '').trim();
const separator = key.indexOf('|');
if (separator < 1 || separator !== key.lastIndexOf('|')) throw new Error('BEAM_TEST_KEY must use BEAM_WORKSPACE_ID|BEAM_TOKEN');
const workspaceId = key.slice(0, separator).trim();
const token = key.slice(separator + 1).trim();
if (!workspaceId || token.length < 16) throw new Error('BEAM_TEST_KEY must use a valid workspace ID and token');
beamOpts.workspaceId = workspaceId;
beamOpts.token = token;

const publicHost = String(process.env.GOST_PUBLIC_HOST || '').trim();
const masterHost = String(process.env.BEAM_GOST_MASTER_HOST || process.env.BLAXEL_GOST_MASTER_HOST || '').trim();
const rendezvousPort = Number(process.env.BEAM_GOST_RENDEZVOUS_PORT || process.env.BLAXEL_GOST_RENDEZVOUS_PORT || 443);
const user = String(process.env.BEAM_GOST_TUNNEL_USERNAME || process.env.BLAXEL_GOST_TUNNEL_USERNAME || '').trim();
const pass = String(process.env.BEAM_GOST_TUNNEL_PASSWORD || process.env.BLAXEL_GOST_TUNNEL_PASSWORD || '').trim();
const version = String(process.env.GOST_VERSION || '3.2.6');
const wsPath = String(process.env.BEAM_GOST_WS_PATH || process.env.BLAXEL_GOST_WS_PATH || '/ws');
if (!publicHost || !masterHost || !user || !pass) throw new Error('GOST_PUBLIC_HOST, BEAM_GOST_MASTER_HOST, BEAM_GOST_TUNNEL_USERNAME and BEAM_GOST_TUNNEL_PASSWORD are required');

const alpha = length => Array.from({ length }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[randomBytes(1)[0] % 62]).join('');
const socksUser = alpha(10), socksPass = alpha(10);
let instance;
let cleaning = false;
const name = `nodenesia-gost-test-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(command, blocking = true) {
  const process = await instance.exec(['sh', '-lc', command]);
  if (!blocking) return process;
  const exitCode = await process.wait();
  if (exitCode !== 0) throw new Error(`Beam process failed (${exitCode}): ${(await process.logs.read()).slice(-1000)}`);
  return process;
}
function socksAuth() {
  return new Promise(resolve => {
    let socket; let stage = 0; let done = false; const finish = ok => { if (done) return; done = true; socket?.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), 5000);
    try { socket = net.createConnection({ host: publicHost, port: TEST_PORT }); } catch { clearTimeout(timer); finish(false); return; }
    socket.on('error', () => { clearTimeout(timer); finish(false); });
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 2])));
    socket.on('data', data => {
      if (!stage && data[0] === 5 && data[1] === 2) { stage = 1; const u = Buffer.from(socksUser), p = Buffer.from(socksPass); socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p])); }
      else if (stage && data[0] === 1 && data[1] === 0) { clearTimeout(timer); finish(true); }
    });
  });
}
async function cleanup(code = 0) { if (cleaning) return; cleaning = true; if (instance) { process.stdout.write('\n[beam-test] Terminating sandbox…\n'); await instance.terminate().catch(error => { process.stderr.write(`[beam-test] Cleanup failed: ${error.message}\n`); code = 1; }); } process.exit(code); }
process.once('SIGINT', () => void cleanup()); process.once('SIGTERM', () => void cleanup());

try {
  process.stdout.write(`[beam-test] Creating sandbox ${name} in workspace ${workspaceId}…\n`);
  instance = await new Sandbox({ name, cpu: 1, memory: 1024, keepWarmSeconds: 3600, image: Image.fromRegistry(process.env.BEAM_IMAGE || 'ubuntu:22.04') }).create();
  const install = `apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar && curl -fsSL -o /tmp/gost.tar.gz https://github.com/go-gost/gost/releases/download/v${version}/gost_${version}_linux_amd64.tar.gz && tar -xzf /tmp/gost.tar.gz -C /tmp gost && chmod +x /tmp/gost`;
  await run(install);
  await run(`/tmp/gost -L='socks5://${encodeURIComponent(socksUser)}:${encodeURIComponent(socksPass)}@127.0.0.1:1080' >/tmp/gost-socks.log 2>&1 &`, false);
  const query = `?path=${encodeURIComponent(wsPath)}&secure=true&serverName=${encodeURIComponent(masterHost)}`;
  await run(`/tmp/gost -L='rtcp://:${TEST_PORT}/127.0.0.1:1080' -F='socks5+wss://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${masterHost}:${rendezvousPort}${query}' >/tmp/gost-tunnel.log 2>&1 &`, false);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) { if (await socksAuth()) break; await wait(1000); }
  if (!await socksAuth()) throw new Error(`SOCKS5 endpoint ${publicHost}:${TEST_PORT} did not become reachable`);
  process.stdout.write(`[beam-test] SOCKS5 ready: socks5://${socksUser}:${socksPass}@${publicHost}:${TEST_PORT}\n[beam-test] Press Ctrl+C to clean the sandbox.\n`);
  await new Promise(() => { setInterval(() => {}, 60000); });
} catch (error) { process.stderr.write(`[beam-test] ${error instanceof Error ? error.message : error}\n`); await cleanup(1); }
