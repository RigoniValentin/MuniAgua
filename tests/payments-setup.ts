import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replset: MongoMemoryReplSet | undefined;

export async function setupReplSetTestDb(): Promise<string> {
  replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const uri = replset.getUri();
  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';
  process.env.JWT_ACCESS_EXPIRES_IN = '15m';
  process.env.JWT_REFRESH_EXPIRES_IN = '7d';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.PAYMENT_RECEIPTS_DIR = './storage/test-payment-receipts';
  process.env.PAYMENT_SUBMIT_RATE_LIMIT = 'disabled';
  process.env.APP_TIMEZONE = 'America/Argentina/Buenos_Aires';
  await mongoose.connect(uri);
  return uri;
}

export async function teardownReplSetTestDb(): Promise<void> {
  await mongoose.disconnect();
  if (replset) {
    await replset.stop();
    replset = undefined;
  }
}

export async function clearReplSetTestDb(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }
}