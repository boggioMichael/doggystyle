import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** repo root: apps/api/src/config -> ../../../.. */
export const REPO_ROOT = path.resolve(here, '../../../..');
export const API_ROOT = path.resolve(here, '../..');

/**
 * Minimal .env loader (no dotenv dependency). Values already present in the real
 * environment always win, so Docker/CI overrides work as expected.
 */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  const raw = readFileSync(file, 'utf8');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

if (!process.env.DOGGYSTYLE_SKIP_ENV_FILE) {
  loadEnvFile(path.join(REPO_ROOT, '.env'));
}

const bool = (def: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const int = (def: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : def;
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ROLE: z.enum(['api', 'worker', 'both']).default('both'),
  LOG_LEVEL: z.string().default('info'),
  LOG_PRETTY: bool(true),

  BRAND_NAME: z.string().default('Doggystyle'),
  BRAND_TAGLINE: z.string().default('Tell us what you want for your dog. We do the rest.'),

  PUBLIC_URL: z.string().default('http://localhost:8080'),
  API_PORT: int(4000),
  HOST: z.string().default('0.0.0.0'),
  /** When true the API also serves the built SPA (single-origin, no reverse proxy needed). */
  SERVE_WEB: bool(false),
  WEB_DIST_DIR: z.string().optional(),

  DATABASE_URL: z.string().default('postgres://doggystyle:doggystyle@localhost:5433/doggystyle'),
  DB_POOL_MAX: int(10),

  SESSION_SECRET: z.string().min(16).default('dev-only-session-secret-change-me!!'),
  TOKEN_PEPPER: z.string().min(16).default('dev-only-token-pepper-change-me!!!!'),
  SESSION_TTL_HOURS: int(720),
  MAGIC_LINK_TTL_MINUTES: int(15),
  COOKIE_SECURE: bool(false),

  MEDIA_DIR: z.string().default('./storage/media'),
  MAX_UPLOAD_MB: int(12),
  MAX_FILES_PER_REQUEST: int(30),

  AI_PROVIDER: z.enum(['heuristic', 'anthropic']).default('heuristic'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  AI_TIMEOUT_MS: int(20000),

  /** `store` keeps mail in the DB and logs it (no SMTP needed). `smtp` sends via SMTP_*. */
  MAIL_TRANSPORT: z.enum(['store', 'smtp']).default('store'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: int(1025),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  MAIL_FROM: z.string().default('Doggystyle <hello@doggystyle.local>'),

  DEMO_MODE: bool(true),
  SEED_ON_START: bool(false),

  INSTAGRAM_APP_ID: z.string().optional().default(''),
  INSTAGRAM_APP_SECRET: z.string().optional().default(''),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),

  RATE_LIMIT_ENABLED: bool(true),

  ADMIN_EMAIL: z.string().default('admin@doggystyle.local'),
  ADMIN_PASSWORD: z.string().default('DemoAdmin!2026'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n\nCheck your .env against .env.example.\n`);
  process.exit(1);
}

const raw = parsed.data;

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  mediaDir: resolveFromRoot(raw.MEDIA_DIR),
  webDistDir: resolveFromRoot(raw.WEB_DIST_DIR ?? 'apps/web/dist'),
  maxUploadBytes: raw.MAX_UPLOAD_MB * 1024 * 1024,
  sessionTtlMs: raw.SESSION_TTL_HOURS * 3600 * 1000,
  magicLinkTtlMs: raw.MAGIC_LINK_TTL_MINUTES * 60 * 1000,
} as const;

export type Env = typeof env;

/** Warn loudly if production is running with development defaults. */
export function assertProductionSecrets(log: { warn: (msg: string) => void }): void {
  if (!env.isProd) return;
  const weak: string[] = [];
  if (env.SESSION_SECRET.includes('dev-only') || env.SESSION_SECRET.includes('change-me')) weak.push('SESSION_SECRET');
  if (env.TOKEN_PEPPER.includes('dev-only') || env.TOKEN_PEPPER.includes('change-me')) weak.push('TOKEN_PEPPER');
  if (!env.COOKIE_SECURE) weak.push('COOKIE_SECURE (should be true behind TLS)');
  if (env.DEMO_MODE) weak.push('DEMO_MODE (should be false)');
  if (weak.length) log.warn(`INSECURE PRODUCTION CONFIG: ${weak.join(', ')}`);
}
