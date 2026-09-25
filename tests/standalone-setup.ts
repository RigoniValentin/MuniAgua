import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { _resetTransactionSupportCache } from '../src/shared/transactions';

let mongo: MongoMemoryServer | undefined;

/**
 * Spin up a MongoMemoryServer WITHOUT ReplicaSet — i.e. a true standalone
 * deployment. Use this to exercise the compensated `runAtomicOperation`
 * fallback in services.
 */
export async function setupStandaloneTestDb(): Promise<string> {
  _resetTransactionSupportCache();
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.MONGO_TRANSACTION_MODE = 'auto';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';
  process.env.JWT_ACCESS_EXPIRES_IN = '15m';
  process.env.JWT_REFRESH_EXPIRES_IN = '7d';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.PAYMENT_RECEIPTS_DIR = './storage/test-payment-receipts';
  process.env.PAYMENT_SUBMIT_RATE_LIMIT = 'disabled';
  await mongoose.connect(uri);
  return uri;
}

export async function teardownStandaloneTestDb(): Promise<void> {
  await mongoose.disconnect();
  if (mongo) {
    await mongo.stop();
    mongo = undefined;
  }
}

export async function clearStandaloneTestDb(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }
}
