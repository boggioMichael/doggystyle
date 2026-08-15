/**
 * Pre-launch environment check. Creates .env with strong secrets on first run
 * and reports anything that would make the stack fail in a confusing way.
 */
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = [];
let fatal = false;

function ok(name, detail = '') {
  rows.push(['  ✓', name, detail]);
}
function warn(name, detail = '') {
  rows.push(['  !', name, detail]);
}
function fail(name, detail = '') {
  rows.push(['  ✗', name, detail]);
  fatal = true;
}

/* ── Node version ───────────────────────────────────────────────────────── */
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok('Node.js', `v${process.versions.node}`);
else fail('Node.js', `v${process.versions.node} — version 22 or newer is required`);

/* ── .env ───────────────────────────────────────────────────────────────── */
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

if (!existsSync(envPath)) {
  try {
    copyFileSync(examplePath, envPath);
    let content = readFileSync(envPath, 'utf8');
    const secret = () => randomBytes(32).toString('hex');
    const dbPassword = secret();

    content = content
      .replace('POSTGRES_PASSWORD=change-me-generated-on-first-run', `POSTGRES_PASSWORD=${dbPassword}`)
      .replace(
        'DATABASE_URL=postgres://doggystyle:change-me-generated-on-first-run@localhost:5433/doggystyle',
        `DATABASE_URL=postgres://doggystyle:${dbPassword}@127.0.0.1:5433/doggystyle`,
      )
      .replace('SESSION_SECRET=change-me-generated-on-first-run', `SESSION_SECRET=${secret()}`)
      .replace('TOKEN_PEPPER=change-me-generated-on-first-run', `TOKEN_PEPPER=${secret()}`);

    writeFileSync(envPath, content);
    ok('.env', 'created with freshly generated secrets');
  } catch (err) {
    fail('.env', `could not create it — ${err.message}`);
  }
} else {
  const content = readFileSync(envPath, 'utf8');
  if (content.includes('change-me-generated-on-first-run')) {
    warn('.env', 'still contains placeholder secrets — delete it and re-run to regenerate');
  } else {
    ok('.env', 'present');
  }
}

/* ── Dependencies ───────────────────────────────────────────────────────── */
if (existsSync(path.join(root, 'node_modules'))) ok('Dependencies', 'installed');
else warn('Dependencies', 'not installed — the launcher will run npm install');

/* ── Ports ──────────────────────────────────────────────────────────────── */
function probe(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(700);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

const [dbOpen, apiOpen] = await Promise.all([probe(5433), probe(4000)]);
if (dbOpen) ok('PostgreSQL :5433', 'already running');
else warn('PostgreSQL :5433', 'not running — the launcher will start it');

if (apiOpen) warn('API :4000', 'something is already listening — run .\\stop.ps1 first');
else ok('API :4000', 'free');

/* ── Web build ──────────────────────────────────────────────────────────── */
if (existsSync(path.join(root, 'apps/web/dist/index.html'))) ok('Web build', 'present');
else warn('Web build', 'not built yet — the launcher will build it');

/* ── Report ─────────────────────────────────────────────────────────────── */
const width = Math.max(...rows.map((r) => r[1].length));
for (const [mark, name, detail] of rows) {
  console.log(`${mark} ${name.padEnd(width)}  ${detail}`);
}

if (fatal) {
  console.error('\nCannot continue until the items marked ✗ are fixed.\n');
  process.exit(1);
}
process.exit(0);
