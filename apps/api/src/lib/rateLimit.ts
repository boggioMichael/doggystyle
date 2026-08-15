import { env } from '../config/env.js';
import { tooManyRequests } from './errors.js';

/**
 * Sliding-window rate limiter backed by an in-process map.
 *
 * Deliberately not Redis: a single API process is the deployment target today
 * (ADR 0008). The `RateLimiter` shape is small enough that swapping in a shared
 * store later touches one file.
 */
interface Bucket {
  hits: number[];
}

export interface RateRule {
  /** Stable name, used in the bucket key and in logs. */
  name: string;
  limit: number;
  windowMs: number;
  message?: string;
}

export const RATE_RULES = {
  login: { name: 'login', limit: 8, windowMs: 15 * 60_000, message: 'Too many sign-in attempts. Try again in a few minutes.' },
  // Keyed on IP, so a household behind one NAT shares this budget — 5/hour was
  // tight enough to block a family signing up together.
  signup: { name: 'signup', limit: 12, windowMs: 60 * 60_000, message: 'Too many accounts created from here. Try again later.' },
  magicLink: { name: 'magic_link', limit: 5, windowMs: 15 * 60_000, message: 'Too many sign-in links requested. Check your inbox.' },
  chat: { name: 'chat', limit: 60, windowMs: 60_000 },
  search: { name: 'search', limit: 30, windowMs: 60_000, message: 'Too many searches. Give it a moment.' },
  upload: { name: 'upload', limit: 20, windowMs: 10 * 60_000, message: 'Too many uploads. Try again shortly.' },
  introduction: { name: 'introduction', limit: 20, windowMs: 24 * 60 * 60_000, message: 'You have sent a lot of introduction requests today.' },
  message: { name: 'message', limit: 120, windowMs: 60 * 60_000 },
  report: { name: 'report', limit: 10, windowMs: 24 * 60 * 60_000 },
  write: { name: 'write', limit: 240, windowMs: 60_000 },
  admin: { name: 'admin', limit: 300, windowMs: 60_000 },
} as const satisfies Record<string, RateRule>;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  /** Returns remaining allowance, or throws 429. */
  check(rule: RateRule, identity: string): number {
    if (!env.RATE_LIMIT_ENABLED) return rule.limit;

    const now = Date.now();
    this.sweep(now);

    const key = `${rule.name}:${identity}`;
    const bucket = this.buckets.get(key) ?? { hits: [] };
    const cutoff = now - rule.windowMs;
    bucket.hits = bucket.hits.filter((t) => t > cutoff);

    if (bucket.hits.length >= rule.limit) {
      this.buckets.set(key, bucket);
      const retryAfterMs = (bucket.hits[0] ?? now) + rule.windowMs - now;
      throw tooManyRequests(rule.message ?? 'Too many requests. Please slow down.', {
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      });
    }

    bucket.hits.push(now);
    this.buckets.set(key, bucket);
    return rule.limit - bucket.hits.length;
  }

  reset(): void {
    this.buckets.clear();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const maxWindow = Math.max(...Object.values(RATE_RULES).map((r) => r.windowMs));
    for (const [key, bucket] of this.buckets) {
      const alive = bucket.hits.filter((t) => t > now - maxWindow);
      if (alive.length === 0) this.buckets.delete(key);
      else bucket.hits = alive;
    }
  }
}

export const rateLimiter = new RateLimiter();
