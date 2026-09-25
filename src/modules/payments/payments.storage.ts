import { createReadStream, promises as fs, mkdirSync, ReadStream } from 'node:fs';
import path from 'node:path';
import { getEnv } from '../../config/env.js';

/**
 * Minimal abstraction for receipt storage. Implementations must guarantee:
 *   - opaque storage keys (UUID-based, no original filenames)
 *   - safe directory traversal (no `..` allowed)
 *   - delete is best-effort and idempotent
 *
 * Designed so the future S3/R2 implementation can be a drop-in replacement.
 */
export interface PaymentReceiptStorage {
  /**
   * Persist the file at `sourcePath` under `storageKey`.
   * Returns the absolute (or canonical) path on disk.
   */
  save(storageKey: string, sourcePath: string): Promise<string>;

  /**
   * Open a stream to read the stored receipt.
   */
  openReadStream(storageKey: string): ReadStream;

  /**
   * Resolve an absolute path on disk. Useful for `res.sendFile()`.
   */
  resolveAbsolutePath(storageKey: string): string;

  /**
   * Whether the storage key currently exists in the backend.
   */
  exists(storageKey: string): Promise<boolean>;

  /**
   * Best-effort delete. Does not throw when the file is missing.
   */
  delete(storageKey: string): Promise<void>;
}

export class LocalPaymentReceiptStorage implements PaymentReceiptStorage {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = path.resolve(baseDir ?? getEnv().PAYMENT_RECEIPTS_DIR);
    try {
      // Synchronous mkdir so the first upload can't race against missing dir.
      // `recursive: true` makes this a no-op if the directory already exists.
      mkdirSync(this.baseDir, { recursive: true });
    } catch (err) {
      // Re-throw with a friendly, actionable message so misconfigured
      // production deployments fail fast at startup rather than on first
      // citizen upload.
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `No se pudo preparar el directorio de comprobantes (${this.baseDir}): ${reason}. Verifique permisos de escritura y la variable PAYMENT_RECEIPTS_DIR.`,
      );
    }
  }

  private resolveKey(storageKey: string): string {
    const safe = path.basename(storageKey);
    if (safe !== storageKey || safe.includes('..') || safe.includes('/')) {
      throw new Error('Invalid storage key');
    }
    return path.join(this.baseDir, safe);
  }

  async save(storageKey: string, sourcePath: string): Promise<string> {
    const target = this.resolveKey(storageKey);
    // Atomic-ish: rename first, then unlink source. We use copyFile + unlink
    // so the caller's temp file (which may live on a different volume/FS)
    // is consumed cleanly.
    await fs.copyFile(sourcePath, target);
    try {
      await fs.unlink(sourcePath);
    } catch {
      // Temp file may already be gone (e.g. OS temp dir cleanup). Non-fatal.
    }
    return target;
  }

  openReadStream(storageKey: string): ReadStream {
    return createReadStream(this.resolveKey(storageKey));
  }

  resolveAbsolutePath(storageKey: string): string {
    return this.resolveKey(storageKey);
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await fs.access(this.resolveKey(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await fs.unlink(this.resolveKey(storageKey));
    } catch {
      // Missing file → idempotent success.
    }
  }
}

let cached: PaymentReceiptStorage | undefined;

export function getPaymentReceiptStorage(): PaymentReceiptStorage {
  if (!cached) {
    cached = new LocalPaymentReceiptStorage();
  }
  return cached;
}

/**
 * Test-only: inject a custom storage (e.g. ephemeral directory).
 */
export function __setPaymentReceiptStorageForTests(
  storage: PaymentReceiptStorage | undefined,
): void {
  cached = storage;
}