import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashToken,
  randomToken,
  verifyPassword,
} from '../src/lib/crypto.js';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password entirely', hash)).toBe(false);
  }, 20_000);

  it('salts — the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  }, 30_000);

  it('never stores the plaintext', async () => {
    const hash = await hashPassword('sup3rs3cret-value');
    expect(hash).not.toContain('sup3rs3cret-value');
    expect(hash.startsWith('scrypt$')).toBe(true);
  }, 20_000);

  it('rejects malformed or missing hashes instead of throwing', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$bad$params$here$nope')).toBe(false);
  });
});

describe('token hashing', () => {
  it('is deterministic and one-way', () => {
    const token = randomToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it('produces unique, high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'much longer string')).toBe(false);
  });
});

describe('OAuth token encryption', () => {
  it('round-trips a secret', () => {
    const plaintext = 'ig-access-token-abc123';
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('uses a fresh IV, so the same input yields different ciphertext', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('returns null for tampered or malformed ciphertext', () => {
    const encrypted = encryptSecret('secret');
    const parts = encrypted.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(decryptSecret(parts.join('.'))).toBeNull();
    expect(decryptSecret('garbage')).toBeNull();
    expect(decryptSecret(null)).toBeNull();
  });
});
