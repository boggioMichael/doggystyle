import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOCATION_PRECISIONS } from '@doggystyle/shared';
import { db } from '../../db/client.js';
import { dogProfiles, dogs, mediaAssets, users } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { coarsenLatLng, geohash, lookupCity } from '../../lib/geo.js';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { revokeAllSessions } from '../../plugins/auth.js';
import { mediaStore } from '../media/store.js';
import { exportUserData, viewerDto } from './service.js';

/* ── Schemas ─────────────────────────────────────────────────────────────── */

const patchMeBodySchema = z
  .object({
    displayName: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    locationPrecision: z.enum(LOCATION_PRECISIONS).optional(),
  })
  .strict();

const deleteMeBodySchema = z.object({ confirm: z.literal(true) }).strict();

/* ── Small helpers ───────────────────────────────────────────────────────── */

/** Zod-validate a body; flattened field errors travel in the 400 payload. */
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw badRequest('Invalid request.', result.error.flatten().fieldErrors);
  return result.data;
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  /* ── GET /me ────────────────────────────────────────────────────────────── */
  app.get('/me', async (req) => {
    const actor = req.requireUser();
    return viewerDto(actor.userId);
  });

  /* ── PATCH /me ──────────────────────────────────────────────────────────── */
  app.patch('/me', async (req) => {
    const actor = req.requireUser();
    const body = parse(patchMeBodySchema, req.body);
    rateLimiter.check(RATE_RULES.write, actor.userId);

    const [before] = await db
      .select({ displayName: users.displayName, city: users.city, locationPrecision: users.locationPrecision })
      .from(users)
      .where(and(eq(users.id, actor.userId), isNull(users.deletedAt)))
      .limit(1);
    if (!before) throw notFound();

    const update: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (body.displayName !== undefined) update.displayName = body.displayName || null;
    if (body.locationPrecision !== undefined) update.locationPrecision = body.locationPrecision;

    // Resolved coarse geography, copied onto the user's dog profiles below so
    // matching keeps using one consistent location.
    let geoCopy: { city: string; country: string; lat: number; lng: number; geohash: string } | null = null;
    if (body.city !== undefined) {
      const known = body.city ? lookupCity(body.city) : undefined;
      if (known) {
        // Known city: store the canonical name plus snapped grid point + 5-char geohash.
        const coarse = coarsenLatLng({ lat: known.lat, lng: known.lng });
        geoCopy = { city: known.city, country: known.country, lat: coarse.lat, lng: coarse.lng, geohash: geohash(coarse, 5) };
        Object.assign(update, geoCopy);
      } else {
        // Unknown city: keep the free-text label but no coordinates at all.
        update.city = body.city || null;
        update.country = null;
        update.lat = null;
        update.lng = null;
        update.geohash = null;
      }
    }

    await db.update(users).set(update).where(eq(users.id, actor.userId));

    if (geoCopy) {
      await db
        .update(dogProfiles)
        .set({ ...geoCopy, updatedAt: new Date() })
        .where(
          inArray(
            dogProfiles.dogId,
            db
              .select({ id: dogs.id })
              .from(dogs)
              .where(and(eq(dogs.ownerId, actor.userId), isNull(dogs.deletedAt))),
          ),
        );
    }

    await recordAudit({
      actorUserId: actor.userId,
      action: 'user.update',
      targetType: 'user',
      targetId: actor.userId,
      summary: 'account settings updated',
      // Coarse, human-scale fields only — no coordinates in the audit trail.
      before: { displayName: before.displayName, city: before.city, locationPrecision: before.locationPrecision },
      after: {
        displayName: body.displayName !== undefined ? body.displayName || null : before.displayName,
        city: body.city !== undefined ? (geoCopy ? geoCopy.city : body.city || null) : before.city,
        locationPrecision: body.locationPrecision ?? before.locationPrecision,
      },
      ipHash: req.clientIpHash,
      requestId: req.requestId,
    });

    return viewerDto(actor.userId);
  });

  /* ── DELETE /me ─────────────────────────────────────────────────────────── */
  app.delete('/me', async (req, reply) => {
    const actor = req.requireUser();
    parse(deleteMeBodySchema, req.body); // explicit {confirm:true} required
    rateLimiter.check(RATE_RULES.write, actor.userId);

    const now = new Date();
    // Tombstone address: frees the unique email slot and removes the PII while
    // keeping the row for referential integrity.
    const tombstone = `deleted-${actor.userId}@deleted.local`;

    await db
      .update(users)
      .set({
        status: 'deleted',
        deletedAt: now,
        email: tombstone,
        emailNormalized: tombstone,
        displayName: null,
        passwordHash: null,
        lat: null,
        lng: null,
        exactLat: null,
        exactLng: null,
        geohash: null,
        updatedAt: now,
      })
      .where(eq(users.id, actor.userId));

    // Dogs disappear from every surface (matching filters on deletedAt/status).
    await db
      .update(dogs)
      .set({ deletedAt: now, status: 'archived', updatedAt: now })
      .where(and(eq(dogs.ownerId, actor.userId), isNull(dogs.deletedAt)));

    // Media: mark rows deleted, then best-effort removal of the files on disk.
    const mediaRows = await db
      .select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey, thumbKey: mediaAssets.thumbKey })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.userId, actor.userId), isNull(mediaAssets.deletedAt)));
    await db
      .update(mediaAssets)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(mediaAssets.userId, actor.userId), isNull(mediaAssets.deletedAt)));
    for (const row of mediaRows) {
      for (const key of [row.storageKey, row.thumbKey]) {
        if (!key) continue;
        try {
          await mediaStore.delete(key);
        } catch (err) {
          // A missing file must never abort an account deletion.
          req.log.warn({ err, mediaId: row.id }, 'failed to delete media file during account deletion');
        }
      }
    }

    await revokeAllSessions(actor.userId);
    reply.clearSessionCookies();

    await recordAudit({
      actorUserId: actor.userId,
      action: 'account.delete',
      targetType: 'user',
      targetId: actor.userId,
      summary: `account soft-deleted (${mediaRows.length} media file(s) removed)`,
      ipHash: req.clientIpHash,
      requestId: req.requestId,
    });

    return { ok: true };
  });

  /* ── GET /me/export ─────────────────────────────────────────────────────── */
  app.get('/me/export', async (req) => {
    const actor = req.requireUser();
    // Export is heavy and personal — budget it like a write.
    rateLimiter.check(RATE_RULES.write, actor.userId);
    return exportUserData(actor.userId);
  });
}
