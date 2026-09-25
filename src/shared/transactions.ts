/**
 * Central transaction helper.
 *
 * MuniBack supports BOTH:
 *   - MongoDB standalone (single mongod)
 *   - MongoDB Replica Set / mongos
 *
 * The decision is centralised here so domain services (`orders`,
 * `payments`, `seed-demo`) don't sprinkle `if (replicaSet)` checks.
 *
 * Strategy:
 *   - `MONGO_TRANSACTION_MODE=auto`      → detect at startup. Use
 *                                          `session.withTransaction()`
 *                                          when supported, otherwise
 *                                          fall back to a compensated
 *                                          sequential write that relies
 *                                          on idempotency keys + unique
 *                                          indexes for safety.
 *   - `MONGO_TRANSACTION_MODE=enabled`   → require transactions; throw on
 *                                          standalone at startup.
 *   - `MONGO_TRANSACTION_MODE=disabled`  → never use transactions, even
 *                                          if the server supports them.
 *
 * The detection happens once per process (after `mongoose.connect`) and
 * is cached for the lifetime of the runtime.
 */
import mongoose, { type ClientSession } from 'mongoose';
import { getEnv } from '../config/env.js';
import { logger } from './logger.js';

export type MongoTransactionMode = 'auto' | 'enabled' | 'disabled';

export interface RunAtomicOptions<T> {
  /** Work to run inside a Mongo transaction (requires session). */
  transactional: (session: ClientSession) => Promise<T>;
  /**
   * Fallback to run when transactions aren't available. The session
   * argument is `undefined`. Implementations must rely on idempotency
   * keys + unique indexes for safety.
   */
  fallback: () => Promise<T>;
  /** Human label used in logs when transactions are unavailable. */
  label: string;
}

export interface RunAtomicResult<T> {
  value: T;
  /** True iff the transactional path was actually used. */
  usedTransaction: boolean;
}

let detectedSupport: boolean | null = null;
let detectionLogged = false;

/**
 * Inspect the live MongoDB topology and decide whether transactions are
 * available. We don't trust `MONGODB_URI` parsing alone — the server may
 * be configured as a replica set even when the URI doesn't include
 * `?replicaSet=`, and conversely the URI may mention `replicaSet=` while
 * the actual topology is misconfigured. The driver's `topology`
 * description is the authoritative source.
 */
export async function detectTransactionSupport(): Promise<boolean> {
  if (detectedSupport !== null) {
    return detectedSupport;
  }
  const env = getEnv();
  const mode: MongoTransactionMode = env.MONGO_TRANSACTION_MODE;
  if (mode === 'disabled') {
    detectedSupport = false;
    return false;
  }
  if (mongoose.connection.readyState !== 1) {
    throw new Error(
      'detectTransactionSupport() called before mongoose was connected',
    );
  }
  // The MongoDB driver's `topology` property isn't exposed on the
  // public TypeScript types, so we treat it as an unknown and only
  // poke at the one field we care about.
  const client = mongoose.connection.getClient?.();
  const topology = (client as unknown as {
    topology?: { description?: { type?: string } };
  } | undefined)?.topology?.description?.type;
  const isReplicaLike =
    topology === 'ReplicaSetWithPrimary' ||
    topology === 'ReplicaSetNoPrimary' ||
    topology === 'Sharded' ||
    topology === 'LoadBalanced';
  const supports = isReplicaLike;
  if (mode === 'enabled' && !supports) {
    throw new Error(
      'MongoDB transactions were explicitly required but the current ' +
        `server is not a Replica Set (topology=${topology ?? 'unknown'}). ` +
        'Either start a MongoDB Replica Set or set MONGO_TRANSACTION_MODE=auto/disabled.',
    );
  }
  detectedSupport = supports;
  if (!detectionLogged) {
    detectionLogged = true;
    if (supports) {
      logger.info('MongoDB transaction support: enabled');
    } else if (mode === 'auto') {
      logger.info(
        'MongoDB standalone detected. Transaction fallback enabled.',
      );
    } else {
      logger.info(
        `MongoDB transaction support: unavailable (topology=${topology ?? 'unknown'})`,
      );
    }
  }
  return supports;
}

/**
 * Lightweight probe exposed for tests so the cache can be reset between
 * runs (different test files use different topologies).
 */
export function _resetTransactionSupportCache(): void {
  detectedSupport = null;
  detectionLogged = false;
}

/**
 * Public read-only access to the cached decision.
 * Returns `false` until the first detection has been performed.
 */
export function supportsTransactions(): boolean {
  return detectedSupport === true;
}

/**
 * Run an operation atomically. When MongoDB supports multi-document
 * transactions we run the supplied `transactional` block inside
 * `session.withTransaction()`. Otherwise we run the `fallback` block,
 * which must use compensating writes + idempotency keys to keep the
 * ledger consistent.
 *
 * Both paths return the same shape, so callers don't need to branch.
 */
export async function runAtomicOperation<T>(
  options: RunAtomicOptions<T>,
): Promise<RunAtomicResult<T>> {
  const supports = await detectTransactionSupport();
  if (!supports) {
    const value = await options.fallback();
    return { value, usedTransaction: false };
  }
  const session = await mongoose.startSession();
  try {
    let value: T | undefined;
    await session.withTransaction(async () => {
      value = await options.transactional(session);
    });
    if (value === undefined) {
      throw new Error(
        `runAtomicOperation(${options.label}): transactional block returned no value`,
      );
    }
    return { value, usedTransaction: true };
  } finally {
    await session.endSession();
  }
}
