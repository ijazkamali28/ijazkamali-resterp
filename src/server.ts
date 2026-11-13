import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const app = await buildApp();
const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
await app.listen({ port: config.PORT, host: config.HOST });
