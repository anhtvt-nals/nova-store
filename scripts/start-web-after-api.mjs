import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';

try {
  loadEnvFile('.env');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const apiPort = Number(process.env.API_PORT || 3001);
const healthUrl = `http://127.0.0.1:${apiPort}/api/health`;
const deadline = Date.now() + 30_000;

process.stdout.write(`[startup] Waiting for Nest API at ${healthUrl}\n`);

while (Date.now() < deadline) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
    if (response.ok) break;
  } catch {
    // The API process is still compiling or binding its port.
  }
  await new Promise(resolve => setTimeout(resolve, 150));
}

if (Date.now() >= deadline) {
  process.stderr.write(`[startup] Nest API did not become ready within 30 seconds: ${healthUrl}\n`);
  process.exit(1);
}

process.stdout.write('[startup] Nest API is ready; starting Vite\n');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const web = spawn(npmCommand, ['run', 'dev:web'], { stdio: 'inherit', env: process.env });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => web.kill(signal));
}

web.on('error', error => {
  process.stderr.write(`[startup] Unable to start Vite: ${error.message}\n`);
  process.exit(1);
});

web.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
