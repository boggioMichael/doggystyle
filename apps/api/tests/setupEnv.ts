/**
 * Must run before any src/ import so config/env.ts sees these values.
 * Pure-function suites need no database; the connection string is only used by
 * suites that import the db client.
 */
process.env.DOGGYSTYLE_SKIP_ENV_FILE = '1';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.TOKEN_PEPPER = 'test-token-pepper-0123456789abcdef';
process.env.MEDIA_DIR = './storage/test-media';
process.env.DEMO_MODE = 'true';
process.env.SEED_ON_START = 'false';
process.env.MAIL_TRANSPORT = 'store';
process.env.AI_PROVIDER = 'heuristic';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://doggystyle:test@127.0.0.1:5433/doggystyle_test';
