#!/usr/bin/env node
// Creates a private temporary repo, dispatches an isolated GOST WSS runner,
// validates SOCKS5 and deletes the repository on completion or Ctrl+C.
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
try { process.loadEnvFile('.env'); } catch {}

const TEST_PORT = 39997;
const [owner, token] = String(process.env.GITHUB_TEST_KEY || '').split('|');
if (!owner || !token || !/^[A-Za-z0-9-]+$/.test(owner)) throw new Error('GITHUB_TEST_KEY must use GITHUB_OWNER|GITHUB_API_KEY');
const masterHost = String(process.env.GITHUB_GOST_MASTER_HOST || process.env.BLAXEL_GOST_MASTER_HOST || '').trim();
const publicHost = String(process.env.GOST_PUBLIC_HOST || '').trim();
const tunnelUser = String(process.env.GITHUB_GOST_TUNNEL_USERNAME || process.env.BLAXEL_GOST_TUNNEL_USERNAME || '').trim();
const tunnelPass = String(process.env.GITHUB_GOST_TUNNEL_PASSWORD || process.env.BLAXEL_GOST_TUNNEL_PASSWORD || '').trim();
const rendezvousPort = String(process.env.GITHUB_GOST_RENDEZVOUS_PORT || process.env.BLAXEL_GOST_RENDEZVOUS_PORT || '443');
const wsPath = String(process.env.GITHUB_GOST_WS_PATH || process.env.BLAXEL_GOST_WS_PATH || '/ws');
const gostVersion = String(process.env.GOST_VERSION || '3.2.6');
if (!masterHost || !publicHost || !tunnelUser || !tunnelPass) throw new Error('GOST_PUBLIC_HOST and GITHUB_GOST_* tunnel settings are required');
const alpha = n => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[randomBytes(1)[0] % 62]).join('');
const socksUser = alpha(10), socksPass = alpha(10);
const repo = `nodenesia-gost-test-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const execFileAsync = promisify(execFile);
let cleaning = false, runId = null, created = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function gh(path, method, body, accepted = [200]) {
  const response = await fetch(`https://api.github.com${path}`, { method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await response.json().catch(() => ({}));
  if (!accepted.includes(response.status)) throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${json.message || response.statusText}`);
  return json;
}
function workflow() { return `name: Nodenesia temporary GOST test
on:
  workflow_dispatch:
    inputs:
      master_host: { required: true, type: string }
      rendezvous_port: { required: true, type: string }
      ws_path: { required: true, type: string }
      tunnel_user: { required: true, type: string }
      tunnel_pass: { required: true, type: string }
      socks_user: { required: true, type: string }
      socks_pass: { required: true, type: string }
      bind_port: { required: true, type: string }
jobs:
  gost:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - shell: bash
        run: |
          set -euo pipefail
          for value in "\${{ inputs.tunnel_user }}" "\${{ inputs.tunnel_pass }}" "\${{ inputs.socks_user }}" "\${{ inputs.socks_pass }}"; do echo "::add-mask::$value"; done
          enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
          curl -fsSL -o /tmp/gost.tgz https://github.com/go-gost/gost/releases/download/v${gostVersion}/gost_${gostVersion}_linux_amd64.tar.gz
          tar -xzf /tmp/gost.tgz -C /tmp gost && chmod +x /tmp/gost
          trap 'jobs -pr | xargs -r kill || true' EXIT INT TERM
          /tmp/gost -L="socks5://$(enc '\${{ inputs.socks_user }}'):$(enc '\${{ inputs.socks_pass }}')@127.0.0.1:1080" >/tmp/socks.log 2>&1 &
          /tmp/gost -L="rtcp://:\${{ inputs.bind_port }}/127.0.0.1:1080" -F="socks5+wss://$(enc '\${{ inputs.tunnel_user }}'):$(enc '\${{ inputs.tunnel_pass }}')@\${{ inputs.master_host }}:\${{ inputs.rendezvous_port }}?path=$(enc '\${{ inputs.ws_path }}')&secure=true&serverName=\${{ inputs.master_host }}" >/tmp/tunnel.log 2>&1 &
          sleep 1140
`; }
function socksAuth() { return new Promise(resolve => { let socket, stage = 0, done = false; const end = value => { if (done) return; done = true; socket?.destroy(); resolve(value); }; const timeout = setTimeout(() => end(false), 5000); socket = net.createConnection({ host: publicHost, port: TEST_PORT }); socket.on('error', () => { clearTimeout(timeout); end(false); }); socket.on('connect', () => socket.write(Buffer.from([5, 1, 2]))); socket.on('data', data => { if (!stage && data[1] === 2) { stage = 1; const u = Buffer.from(socksUser), p = Buffer.from(socksPass); socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p])); } else if (stage && data[1] === 0) { clearTimeout(timeout); end(true); } }); }); }
async function cleanup(code = 0) { if (cleaning) return; cleaning = true; if (runId) await gh(`/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, 'POST', undefined, [202, 409, 422, 404]).catch(() => undefined); if (created) { process.stdout.write('\n[github-test] Deleting temporary repository…\n'); await gh(`/repos/${owner}/${repo}`, 'DELETE', undefined, [204, 404]).catch(error => { process.stderr.write(`[github-test] Cleanup failed: ${error.message}\n`); code = 1; }); } process.exit(code); }
process.once('SIGINT', () => void cleanup()); process.once('SIGTERM', () => void cleanup());
try {
  process.stdout.write(`[github-test] Creating private repository ${owner}/${repo}…\n`);
  await gh('/user/repos', 'POST', { name: repo, private: true, auto_init: false, has_issues: false, has_projects: false, has_wiki: false }, [201]); created = true;
  await gh(`/repos/${owner}/${repo}/contents/.github/workflows/gost-test.yml`, 'PUT', { message: 'Add temporary GOST test workflow', content: Buffer.from(workflow()).toString('base64') }, [201]);
  await wait(2000);
  await gh(`/repos/${owner}/${repo}/actions/workflows/gost-test.yml/dispatches`, 'POST', { ref: 'main', inputs: { master_host: masterHost, rendezvous_port: rendezvousPort, ws_path: wsPath, tunnel_user: tunnelUser, tunnel_pass: tunnelPass, socks_user: socksUser, socks_pass: socksPass, bind_port: String(TEST_PORT) } }, [204]);
  process.stdout.write('[github-test] Workflow dispatched; waiting for SOCKS5…\n');
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { const runs = await gh(`/repos/${owner}/${repo}/actions/runs?event=workflow_dispatch&per_page=1`, 'GET'); runId = runs.workflow_runs?.[0]?.id || runId; if (await socksAuth()) break; await wait(1500); }
  if (!await socksAuth()) throw new Error(`SOCKS5 endpoint ${publicHost}:${TEST_PORT} did not become reachable`);
  const proxy = `socks5h://${socksUser}:${socksPass}@${publicHost}:${TEST_PORT}`;
  const { stdout } = await execFileAsync('curl', ['--silent', '--show-error', '--fail', '--max-time', '20', '--proxy', proxy, 'https://api.ipify.org']);
  process.stdout.write(`[github-test] SOCKS5 ready; proxy egress IP: ${String(stdout).trim()}\n[github-test] Test completed; cleaning all temporary resources…\n`);
  await cleanup(0);
} catch (error) { process.stderr.write(`[github-test] ${error.message || error}\n`); await cleanup(1); }
