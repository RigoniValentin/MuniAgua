// Cross-platform equivalent of `rimraf <path>`.
// Removes the given path (file or directory) using Node's native fs.
import { rmSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
  process.stderr.write('[clean] Usage: clean.mjs <path>\n');
  process.exit(1);
}

try {
  rmSync(target, { recursive: true, force: true });
  process.stdout.write(`[clean] Removed ${target}\n`);
} catch (err) {
  process.stderr.write(`[clean] ERROR removing ${target}: ${err.message}\n`);
  process.exit(1);
}
