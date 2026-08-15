import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { schema } from './schema.js';

/**
 * Single shared connection pool. `postgres.js` is a pure-JS driver — no native
 * build step, which matters for a Windows-first local deployment.
 */
export const sql = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  idle_timeout: 30,
  connect_timeout: 15,
  onnotice: () => {},
  transform: { undefined: null },
});

export const db = drizzle(sql, { schema });

export type Db = typeof db;
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

export async function pingDb(): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** Wait for Postgres to accept connections (used by start scripts and migrations). */
export async function waitForDb(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sql`select 1`;
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `Database not reachable at ${env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')} after ${timeoutMs}ms: ${String(lastError)}`,
  );
}
