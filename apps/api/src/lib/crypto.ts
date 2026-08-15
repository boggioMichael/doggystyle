import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { env } from '../config/env.js';

/** promisify() drops the options-bearing overload, so wrap scrypt by hand. */
const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)));
  });

/* ── Random ids & tokens ─────────────────────────────────────────────────── */

export const newId = (): string => randomUUID();

/** URL-safe random token. 32 bytes = 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/* ── Token hashing (sessions, magic links) ───────────────────────────────── */

/**
 * Tokens are stored only as SHA-256(token + pepper). A database leak therefore
 * does not yield usable session tokens.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(`${token}${env.TOKEN_PEPPER}`).digest('hex');
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHmac('sha256', env.TOKEN_PEPPER).update(ip).digest('hex').slice(0, 32);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a comparison to keep timing flat-ish.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/* ── Password hashing ────────────────────────────────────────────────────── */

/**
 * scrypt with OWASP-recommended parameters (N=2^16, r=8, p=1, 64-byte output).
 * Chosen over argon2 to avoid a native build dependency on a Windows-first
 * local deployment; scrypt is memory-hard and part of Node's standard library.
 * Format: scrypt$N$r$p$saltB64$hashB64
 */
const SCRYPT_N = 1 << 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number.parseInt(nStr, 10);
  const r = Number.parseInt(rStr, 10);
  const p = Number.parseInt(pStr, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* ── Symmetric encryption for third-party OAuth tokens ───────────────────── */

let cachedKey: Buffer | null = null;
function encryptionKey(): Buffer {
  if (!cachedKey) {
    cachedKey = createHash('sha256').update(`${env.TOKEN_PEPPER}:oauth-token-encryption`).digest();
  }
  return cachedKey;
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1] as string, 'base64url');
    const tag = Buffer.from(parts[2] as string, 'base64url');
    const ct = Buffer.from(parts[3] as string, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}
