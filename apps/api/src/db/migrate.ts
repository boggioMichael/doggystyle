import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { API_ROOT } from '../config/env.js';
import { closeDb, sql, waitForDb } from './client.js';
import { logger } from '../lib/logger.js';

const MIGRATIONS_DIR = path.join(API_ROOT, 'drizzle');

/**
 * A deliberately small, transparent migration runner.
 *
 * Migrations are plain .sql files applied in filename order inside a single
 * transaction each, and recorded in `_migrations` with a checksum so that an
 * already-applied file cannot be silently edited.
 */
export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  await waitForDb();

  await sql`
    create table if not exists _migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const existing = await sql<{ name: string; checksum: string }[]>`select name, checksum from _migrations`;
  const applied = new Map(existing.map((r) => [r.name, r.checksum]));

  const didApply: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const raw = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(raw).digest('hex');
    const previous = applied.get(file);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} was modified after it was applied (checksum mismatch).\n` +
            `Create a new migration instead of editing an applied one.`,
        );
      }
      skipped.push(file);
      continue;
    }

    const statements = raw
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)*$/.test(s));

    logger.info({ file, statements: statements.length }, 'applying migration');

    await sql.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }
      await tx`insert into _migrations (name, checksum) values (${file}, ${checksum})`;
    });

    didApply.push(file);
  }

  return { applied: didApply, skipped };
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isDirectRun) {
  runMigrations()
    .then(({ applied, skipped }) => {
      if (applied.length === 0) {
        logger.info(`Database is up to date (${skipped.length} migration(s) already applied).`);
      } else {
        logger.info(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
      }
      return closeDb();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
