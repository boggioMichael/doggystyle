import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { assertProductionSecrets, env } from './config/env.js';
import { closeDb, waitForDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { startWorker, stopWorker } from './jobs/worker.js';
import { runSeed } from './seed/seed.js';

async function main(): Promise<void> {
  assertProductionSecrets(logger);
  mkdirSync(env.mediaDir, { recursive: true });

  logger.info({ role: env.ROLE, env: env.NODE_ENV }, `${env.BRAND_NAME} starting`);

  await waitForDb();
  const { applied } = await runMigrations();
  if (applied.length) logger.info(`applied ${applied.length} migration(s)`);

  if (env.SEED_ON_START) {
    const result = await runSeed({ force: false });
    logger.info(result, 'seed check complete');
  }

  const runsApi = env.ROLE === 'api' || env.ROLE === 'both';
  const runsWorker = env.ROLE === 'worker' || env.ROLE === 'both';

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  if (runsWorker) {
    startWorker();
    logger.info('background worker started');
  }

  if (runsApi) {
    app = await buildApp();
    await app.listen({ port: env.API_PORT, host: env.HOST });
    logger.info(
      `${env.BRAND_NAME} API listening on http://localhost:${env.API_PORT}` +
        (env.SERVE_WEB ? ` — open ${env.PUBLIC_URL}` : ''),
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await stopWorker();
      if (app) await app.close();
      await closeDb();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
