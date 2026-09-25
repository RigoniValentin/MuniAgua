// Cross-platform script: builds MuniFront and copies dist into MuniBack/public.
// Resolves sibling directory regardless of OS.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MUNIBACK_DIR = path.resolve(__dirname, '..');
// MuniFront sits at <workspace>/MuniFront, sibling of MuniBack
const MUNIFRONT_DIR = path.resolve(MUNIBACK_DIR, '..', 'MuniFront');
const FRONT_DIST = path.join(MUNIFRONT_DIR, 'dist');
const BACK_PUBLIC = path.join(MUNIBACK_DIR, 'public');

function info(msg) {
  process.stdout.write(`[copy-front] ${msg}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`[copy-front] ERROR: ${msg}\n`);
  process.exit(code);
}

if (!existsSync(MUNIFRONT_DIR)) {
  fail(`MuniFront directory not found at ${MUNIFRONT_DIR}`);
}

// Step 1: build the frontend
info(`Building MuniFront at ${MUNIFRONT_DIR} ...`);
const buildResult = spawnSync('npm', ['run', 'build'], {
  cwd: MUNIFRONT_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (buildResult.status !== 0) {
  fail('Frontend build failed', buildResult.status ?? 1);
}

// Step 2: clean MuniBack/public
if (existsSync(BACK_PUBLIC)) {
  info(`Cleaning ${BACK_PUBLIC} ...`);
  rmSync(BACK_PUBLIC, { recursive: true, force: true });
}
mkdirSync(BACK_PUBLIC, { recursive: true });

// Step 3: copy dist -> public
if (!existsSync(FRONT_DIST)) {
  fail(`MuniFront dist not found at ${FRONT_DIST} after build`);
}

info(`Copying ${FRONT_DIST} -> ${BACK_PUBLIC} ...`);
cpSync(FRONT_DIST, BACK_PUBLIC, { recursive: true });

info('Done.');
