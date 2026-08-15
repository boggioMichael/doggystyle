import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { HealthDto } from '@doggystyle/shared';
import { env } from '../../config/env.js';
import { db, pingDb } from '../../db/client.js';
import { KNOWN_CITIES } from '../../lib/geo.js';
import { jobs } from '../../db/schema.js';
import { getAiProvider } from '../../ai/index.js';

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness + dependency check. Intentionally unauthenticated but low-detail. */
  app.get('/health', async (_req, reply) => {
    const dbOk = await pingDb();
    const checks: HealthDto['checks'] = [
      { name: 'database', ok: dbOk },
      { name: 'ai_provider', ok: true, detail: getAiProvider().id },
      { name: 'media_dir', ok: true, detail: env.MEDIA_DIR },
    ];

    if (dbOk) {
      try {
        const [stuck] = await db.select({ n: count() }).from(jobs).where(eq(jobs.status, 'dead_letter'));
        checks.push({
          name: 'jobs',
          ok: (stuck?.n ?? 0) === 0,
          detail: `${stuck?.n ?? 0} dead-lettered`,
        });
      } catch {
        checks.push({ name: 'jobs', ok: false });
      }
    }

    const body: HealthDto = {
      status: checks.every((c) => c.ok) ? 'ok' : 'degraded',
      version: '0.1.0',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks,
    };
    reply.status(body.status === 'ok' ? 200 : 503).send(body);
  });

  /** Public branding + capability descriptor, used by the web app on boot. */
  app.get('/config', async () => ({
    brand: { name: env.BRAND_NAME, tagline: env.BRAND_TAGLINE },
    demoMode: env.DEMO_MODE,
    aiProvider: getAiProvider().id,
    minimumAgeYears: 18,
    knownCities: KNOWN_CITIES.map((c) => ({ city: c.city, country: c.country })),
  }));
}
