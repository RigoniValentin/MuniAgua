import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { connectMongo, disconnectMongo } from './config/mongo.js';
import { logger } from './shared/logger.js';

async function bootstrap(): Promise<void> {
  try {
    loadEnv();
  } catch (err) {
    logger.error('Environment validation failed', err);
    process.exit(1);
  }

  const env = loadEnv();

  try {
    await connectMongo();
  } catch (err) {
    logger.error('Failed to start: MongoDB connection error', err);
    process.exit(1);
  }

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info(`MuniBack listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down...`);
    server.close(async () => {
      await disconnectMongo();
      logger.info('HTTP server closed');
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection', reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', err);
  });
}

void bootstrap();
