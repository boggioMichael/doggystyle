import { closeDb, waitForDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { logger } from '../lib/logger.js';
import { runSeed } from './seed.js';

const force = process.argv.includes('--force');

async function main(): Promise<void> {
  await waitForDb();
  await runMigrations();
  const result = await runSeed({ force });
  if (result.skipped) logger.info('Seed skipped — data already present. Use --force to re-seed.');
  else logger.info(result, 'Seed finished');
  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exit(1);
  });
