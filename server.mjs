import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';

// A .env file, when present, wins over variables already set in the shell or the operating system.
const overridden = [];
if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
    if (process.env[key] !== undefined && process.env[key] !== value) overridden.push(key);
    process.env[key] = value;
  }
}

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
if (overridden.length) logger.warn('env.overridden', { keys: overridden, note: '.env replaced values already set in the environment' });

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
