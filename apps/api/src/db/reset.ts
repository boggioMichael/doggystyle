import { env } from '../config/env.js';
import { closeDb, sql, waitForDb } from './client.js';
import { runMigrations } from './migrate.js';
import { logger } from '../lib/logger.js';
import { runSeed } from '../seed/seed.js';

/** Destructive: drops and rebuilds the whole schema. Never allowed in production. */
async function main(): Promise<void> {
  if (env.isProd) {
    logger.error('db:reset refuses to run with NODE_ENV=production');
    process.exit(1);
  }

  await waitForDb();
  logger.warn('dropping schema public …');
  await sql.unsafe('drop schema public cascade');
  await sql.unsafe('create schema public');

  await runMigrations();
  const result = await runSeed({ force: true });
  logger.info(result, 'database reset and re-seeded');
  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'reset failed');
    process.exit(1);
  });
