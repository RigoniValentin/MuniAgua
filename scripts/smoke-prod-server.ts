/* eslint-disable no-console */
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const uri = replset.getUri();
  const storageDir = path.join(os.tmpdir(), `muni-prod-smoke-${Date.now()}`);
  await fs.mkdir(storageDir, { recursive: true });

  const env = {
    ...process.env,
    MONGODB_URI: uri,
    NODE_ENV: 'production',
    PORT: '3010',
    JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    FRONTEND_URL: 'http://localhost:3010',
    REFRESH_COOKIE_NAME: 'muni_rt',
    PAYMENT_RECEIPTS_DIR: storageDir,
    PAYMENT_SUBMIT_RATE_LIMIT: 'disabled',
  };

  const serverPath = path.resolve(__dirname, '../dist/server.js');
  const child = spawn('node', [serverPath], {
    env,
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
  });

  await sleep(2000);

  const probes: Array<{ path: string; expect: (status: number) => boolean; description: string }> = [
    { path: '/api/health', expect: (s) => s === 200, description: 'health endpoint' },
    { path: '/api/inexistente', expect: (s) => s === 404, description: 'API 404 returns JSON' },
    { path: '/', expect: (s) => s === 200, description: 'SPA root (index.html)' },
    { path: '/ciudadano/pedidos', expect: (s) => s === 200, description: 'SPA deep link /ciudadano/pedidos' },
    { path: '/admin/pedidos', expect: (s) => s === 200, description: 'SPA deep link /admin/pedidos' },
    { path: '/repartidor', expect: (s) => s === 200, description: 'SPA deep link /repartidor' },
  ];

  let failed = 0;
  for (const probe of probes) {
    try {
      const res = await fetch(`http://localhost:3010${probe.path}`);
      const ok = probe.expect(res.status);
      const contentType = res.headers.get('content-type') ?? '';
      let snippet = '';
      if (contentType.includes('application/json')) {
        const text = await res.text();
        snippet = text.slice(0, 80);
      } else {
        snippet = contentType;
      }
      console.log(
        `${ok ? '✓' : '✗'} ${probe.description.padEnd(40)} ${probe.path.padEnd(28)} → ${res.status} (${snippet})`,
      );
      if (!ok) failed++;
    } catch (err) {
      console.log(`✗ ${probe.description} — ${probe.path} → fetch failed: ${err}`);
      failed++;
    }
  }

  child.kill();
  await sleep(500);
  await replset.stop();
  try {
    await fs.rm(storageDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (failed > 0) {
    console.log(`\n${failed} probe(s) failed.`);
    console.log('--- server stdout ---\n' + stdout);
    console.log('--- server stderr ---\n' + stderr);
    process.exit(1);
  } else {
    console.log('\n✅ Production server probes OK');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
