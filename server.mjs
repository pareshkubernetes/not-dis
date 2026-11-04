import { existsSync } from 'node:fs';
import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const server = createApp(config, logger).listen(config.PORT, () => {
  logger.info('server.started', { port: config.PORT, env: config.NODE_ENV });
});

const shutdown = (signal) => {
  logger.info('server.stopping', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
