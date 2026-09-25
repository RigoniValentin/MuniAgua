import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongo: MongoMemoryServer | undefined;

export async function setupTestDb(): Promise<string> {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';
  process.env.JWT_ACCESS_EXPIRES_IN = '15m';
  process.env.JWT_REFRESH_EXPIRES_IN = '7d';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.APP_TIMEZONE = 'America/Argentina/Buenos_Aires';
  await mongoose.connect(uri);
  return uri;
}

export async function teardownTestDb(): Promise<void> {
  await mongoose.disconnect();
  if (mongo) {
    await mongo.stop();
    mongo = undefined;
  }
}

export async function clearTestDb(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }
}
