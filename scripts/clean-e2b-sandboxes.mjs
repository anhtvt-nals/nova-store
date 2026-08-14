#!/usr/bin/env node

import { createHash } from 'node:crypto';
import process from 'node:process';
import { Sandbox } from 'e2b';

const execute = process.argv.includes('--execute');
const confirmArgument = process.argv.find(argument => argument.startsWith('--confirm='));
const suppliedConfirmation = confirmArgument?.slice('--confirm='.length) || '';
const concurrencyArgument = process.argv.find(argument => argument.startsWith('--concurrency='));
const concurrency = Number(concurrencyArgument?.slice('--concurrency='.length) || 5);

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
  fail('--concurrency must be an integer between 1 and 20.');
}

function fail(message) {
  console.error(`[clean-e2b] ERROR: ${message}`);
  process.exit(1);
}

async function readHiddenApiKey() {
  if (process.env.E2B_CLEANUP_API_KEY) return process.env.E2B_CLEANUP_API_KEY.trim();
  if (!process.stdin.isTTY) {
    fail('Interactive input is unavailable. Set E2B_CLEANUP_API_KEY for this process.');
  }

  process.stdout.write('E2B API key: ');
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function listSandboxes(apiKey) {
  const paginator = Sandbox.list({ apiKey, limit: 100 });
  const sandboxes = [];
  while (paginator.hasNext) {
    const page = await paginator.nextItems({ apiKey, requestTimeoutMs: 30_000 });
    sandboxes.push(...page);
  }
  return sandboxes;
}

function printSandboxes(sandboxes) {
  if (!sandboxes.length) {
    console.log('[clean-e2b] No running or paused sandboxes found.');
    return;
  }

  console.table(sandboxes.map(sandbox => ({
    sandboxId: sandbox.sandboxId,
    state: sandbox.state,
    startedAt: sandbox.startedAt?.toISOString?.() || String(sandbox.startedAt || '—'),
    endsAt: sandbox.endAt?.toISOString?.() || String(sandbox.endAt || '—'),
    managedBy: sandbox.metadata?.managedBy || '—',
  })));
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function killWithRetry(sandboxId, apiKey) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const killed = await Sandbox.kill(sandboxId, { apiKey, requestTimeoutMs: 30_000 });
      return killed ? 'killed' : 'not-found';
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function killAll(sandboxes, apiKey) {
  const results = new Array(sandboxes.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, sandboxes.length) }, async () => {
    while (nextIndex < sandboxes.length) {
      const index = nextIndex;
      nextIndex += 1;
      const sandbox = sandboxes[index];
      try {
        const status = await killWithRetry(sandbox.sandboxId, apiKey);
        results[index] = { sandboxId: sandbox.sandboxId, status };
        console.log(`[clean-e2b] ${status}: ${sandbox.sandboxId}`);
      } catch (error) {
        results[index] = {
          sandboxId: sandbox.sandboxId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
        console.error(`[clean-e2b] failed: ${sandbox.sandboxId}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

let apiKey;
try {
  apiKey = await readHiddenApiKey();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (!apiKey) fail('E2B API key cannot be empty.');

const fingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
const confirmation = `DELETE_ALL_E2B_SANDBOXES:${fingerprint}`;

let sandboxes;
try {
  sandboxes = await listSandboxes(apiKey);
} catch (error) {
  fail(`Unable to list sandboxes for key fingerprint ${fingerprint}: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`[clean-e2b] API key fingerprint: ${fingerprint}`);
console.log(`[clean-e2b] Found ${sandboxes.length} running or paused sandbox(es).`);
printSandboxes(sandboxes);

if (!execute) {
  console.log('[clean-e2b] Dry run only; no sandbox was killed.');
  console.log('[clean-e2b] Run again with:');
  console.log(`npm run clean:e2b-sandboxes -- --execute --confirm='${confirmation}'`);
  process.exit(0);
}

if (suppliedConfirmation !== confirmation) {
  fail(`Confirmation mismatch. Expected --confirm='${confirmation}'`);
}

if (!sandboxes.length) process.exit(0);

console.log(`[clean-e2b] Killing ${sandboxes.length} sandbox(es) with concurrency ${concurrency}.`);
const results = await killAll(sandboxes, apiKey);
const failures = results.filter(result => result.status === 'failed');
if (failures.length) {
  console.table(failures);
  fail(`${failures.length} sandbox(es) could not be killed after three attempts.`);
}

let remaining;
try {
  remaining = await listSandboxes(apiKey);
} catch (error) {
  fail(`Kills completed, but verification failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (remaining.length) {
  printSandboxes(remaining);
  fail(`${remaining.length} sandbox(es) still remain. They may have been created while cleanup was running.`);
}

console.log(`[clean-e2b] Cleanup complete. ${sandboxes.length} sandbox(es) were removed.`);

