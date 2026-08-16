#!/usr/bin/env node
// Deletes only temporary sandboxes created by test-blaxel-gost.mjs.
// Usage: BLAXEL_TEST_KEY='workspace|api-key' npm run clean:blaxel-gost-tests

try { process.loadEnvFile('.env'); } catch {}

const apiBaseUrl = String(process.env.BLAXEL_API_BASE_URL || 'https://api.blaxel.ai/v0').replace(/\/$/, '');
const apiVersion = String(process.env.BLAXEL_API_VERSION || '2026-04-16');
const { workspace, apiKey } = parseKey(process.env.BLAXEL_TEST_KEY || process.env.BLAXEL_PROVIDER_KEY || '');

function parseKey(value) {
  const separator = value.indexOf('|');
  const workspace = value.slice(0, separator).trim();
  const apiKey = value.slice(separator + 1).trim();
  if (separator < 1 || separator !== value.lastIndexOf('|') || !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(workspace) || apiKey.length < 8) {
    throw new Error('BLAXEL_TEST_KEY must use BLAXEL_WORKSPACE|BLAXEL_API_KEY');
  }
  return { workspace, apiKey };
}

async function request(method, path) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      'X-Blaxel-Authorization': `Bearer ${apiKey}`,
      'X-Blaxel-Workspace': workspace,
      'Blaxel-Version': apiVersion,
    },
  });
  if (!response.ok) throw new Error(`Blaxel API ${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 500) || response.statusText}`);
  if (response.status === 204) return undefined;
  return response.json();
}

const result = await request('GET', '/sandboxes?limit=200');
const sandboxes = Array.isArray(result) ? result : result.data || [];
const tests = sandboxes.filter(sandbox => sandbox.metadata?.labels?.managedBy === 'nodenesia-gost-test');

if (tests.length === 0) {
  process.stdout.write('[blaxel-clean] No temporary Blaxel GOST test sandboxes found.\n');
  process.exit(0);
}

for (const sandbox of tests) {
  const name = sandbox.metadata?.name;
  if (!name) continue;
  await request('DELETE', `/sandboxes/${encodeURIComponent(name)}`);
  process.stdout.write(`[blaxel-clean] Deleted ${name}\n`);
}

process.stdout.write(`[blaxel-clean] Removed ${tests.length} temporary sandbox${tests.length === 1 ? '' : 'es'}; port 39999 will be released when the reverse tunnel disconnects.\n`);
