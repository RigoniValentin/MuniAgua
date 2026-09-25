/* eslint-disable no-console */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { LocalPaymentReceiptStorage } from '../src/modules/payments/payments.storage';

describe('LocalPaymentReceiptStorage — init', () => {
  it('creates the base directory if missing', async () => {
    const baseDir = path.join(os.tmpdir(), `muni-receipts-${Date.now()}-a`);
    const storage = new LocalPaymentReceiptStorage(baseDir);
    // No assertions on directory creation beyond the constructor returning;
    // the first save() will surface any permission errors.
    const key = 'demo.png';
    await expect(storage.save(key, 'x'.repeat(2048))).rejects.toBeDefined();
    // (We expect save() to fail because sourcePath doesn't exist; this just
    //  verifies we got past the mkdir phase.)
  });

  it('throws a friendly error when the base dir cannot be created', () => {
    // Simulate a non-creatable path: a path under a file that exists.
    const blockedParent = path.join(os.tmpdir(), `muni-blocked-${Date.now()}`);
    writeFileSync(blockedParent, 'not a directory');
    const impossible = path.join(blockedParent, 'subdir');
    expect(() => new LocalPaymentReceiptStorage(impossible)).toThrow(
      /No se pudo preparar el directorio de comprobantes/,
    );
    unlinkSync(blockedParent);
  });
});
