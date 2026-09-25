import mongoose from 'mongoose';
import { getEnv } from './env.js';
import { logger } from '../shared/logger.js';
import { detectTransactionSupport } from '../shared/transactions.js';

let isConnected = false;

export async function connectMongo(): Promise<typeof mongoose> {
  if (isConnected) {
    return mongoose;
  }

  const env = getEnv();

  mongoose.connection.on('connected', () => {
    isConnected = true;
    logger.info(`MongoDB connected: ${maskUri(env.MONGODB_URI)}`);
  });

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', err);
  });

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('MongoDB disconnected');
  });

  try {
    const conn = await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 20,
    });
    // Decide once at startup whether the deployment supports transactions.
    // Throws when MONGO_TRANSACTION_MODE=enabled and the server is standalone.
    await detectTransactionSupport();
    return conn;
  } catch (err) {
    logger.error('Failed to connect to MongoDB', err);
    throw err;
  }
}

export async function disconnectMongo(): Promise<void> {
  if (!isConnected) {
    return;
  }
  await mongoose.disconnect();
  isConnected = false;
}

export function getMongoState(): 'connected' | 'disconnected' {
  // 1 === connected
  return mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
}

function maskUri(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}
