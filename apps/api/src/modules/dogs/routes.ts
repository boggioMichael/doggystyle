import { REPRODUCTIVE_STATUSES } from '@doggystyle/shared';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { breedingRecords, dogProfiles, dogs } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import {
  applyAttributeUpdates,
  assertDogOwner,
  confirmAttributes,
  createDogWithProfile,
  generateProfileFromMedia,
  getDogProfileDto,
} from './service.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Schemas
 * ───────────────────────────────────────────────────────────────────────────*/

const dogIdParams = z.object({ dogId: z.string().uuid() });

const createDogBody = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

const attributeUpdatesBody = z
  .object({
    updates: z
      .array(
        z
          .object({
            key: z.string().min(1).max(64),
            // Per-key value validation happens in the service (ADR 0006 choke point).
            value: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();

const confirmBody = z
  .object({
    keys: z.array(z.string().min(1).max(64)).min(1).max(40),
  })
  .strict();

const generateBody = z
  .object({
    clusterId: z.string().min(1).max(64).optional(),
  })
  .strict();

const isoDate = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO date.');

/** Owner-entered breeding data. Absent = unchanged; null = cleared. */
const breedingBody = z
  .object({
    reproductiveStatus: z.enum(REPRODUCTIVE_STATUSES).nullable().optional(),
    registrationNumber: z.string().trim().max(60).nullable().optional(),
    pedigree: z.string().trim().max(200).nullable().optional(),
    geneticTests: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
    healthScreenings: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
    vetClearance: z.string().trim().max(200).nullable().optional(),
    lastSeasonDate: isoDate.nullable().optional(),
    littersWhelped: z.number().int().min(0).max(20).nullable().optional(),
    availableFrom: isoDate.nullable().optional(),
    matingNotes: z.string().trim().max(400).nullable().optional(),
  })
  .strict();

/* ─────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────────────────────*/

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw badRequest('Invalid request body.', result.error.flatten());
  return result.data;
}

function parseParams<S extends z.ZodTypeAny>(schema: S, params: unknown): z.infer<S> {
  const result = schema.safeParse(params ?? {});
  if (!result.success) throw badRequest('Invalid request parameters.', result.error.flatten());
  return result.data;
}

const emptyToNull = (v: string | null): string | null => (v === null ? null : v.trim() || null);

/* ─────────────────────────────────────────────────────────────────────────────
 * Routes
 * ───────────────────────────────────────────────────────────────────────────*/

export async function registerDogRoutes(app: FastifyInstance): Promise<void> {
  /** All of the actor's live dogs, primary first. */
  app.get('/dogs', async (req) => {
    const actor = req.requireUser();
    const rows = await db
      .select({ id: dogs.id })
      .from(dogs)
      .where(and(eq(dogs.ownerId, actor.userId), isNull(dogs.deletedAt)))
      .orderBy(desc(dogs.isPrimary), asc(dogs.createdAt));
    const dtos = [];
    // Sequential on purpose: small N, and it keeps pool pressure predictable.
    for (const row of rows) dtos.push(await getDogProfileDto(row.id, actor.userId));
    return dtos;
  });

  app.post('/dogs', async (req, reply) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const body = parseBody(createDogBody, req.body);
    const dogId = await createDogWithProfile(actor.userId, body.name ? { name: body.name } : undefined);
    reply.status(201);
    return getDogProfileDto(dogId, actor.userId);
  });

  /** Owner-only; a foreign dog id yields 404, never 403 (no id enumeration). */
  app.get('/dogs/:dogId', async (req) => {
    const actor = req.requireUser();
    const { dogId } = parseParams(dogIdParams, req.params);
    return getDogProfileDto(dogId, actor.userId);
  });

  app.patch('/dogs/:dogId/attributes', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { dogId } = parseParams(dogIdParams, req.params);
    const body = parseBody(attributeUpdatesBody, req.body);
    return applyAttributeUpdates({
      dogId,
      actorUserId: actor.userId,
      // Owner-entered values are confirmed by definition.
      updates: body.updates.map((u) => ({ key: u.key, value: u.value, confidence: 1, userConfirmed: true })),
      source: 'user',
      requestId: req.requestId,
    });
  });

  app.post('/dogs/:dogId/confirm', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { dogId } = parseParams(dogIdParams, req.params);
    const body = parseBody(confirmBody, req.body);
    return confirmAttributes({ dogId, actorUserId: actor.userId, keys: body.keys, requestId: req.requestId });
  });

  app.post('/dogs/:dogId/generate', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { dogId } = parseParams(dogIdParams, req.params);
    const body = parseBody(generateBody, req.body);
    return generateProfileFromMedia({
      userId: actor.userId,
      dogId,
      ...(body.clusterId ? { clusterId: body.clusterId } : {}),
      requestId: req.requestId,
    });
  });

  /**
   * Breeding data is owner-entered only — never model-inferred (ADR 0006).
   * The reproductive status is mirrored into the provenance table so its
   * source and history stay auditable like every other sensitive fact.
   */
  app.patch('/dogs/:dogId/breeding', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { dogId } = parseParams(dogIdParams, req.params);
    const body = parseBody(breedingBody, req.body);
    await assertDogOwner(dogId, actor.userId);

    const providedKeys = Object.keys(body);
    if (providedKeys.length === 0) throw badRequest('Nothing to update.');

    const patch: Partial<typeof breedingRecords.$inferInsert> = {};
    if (body.reproductiveStatus !== undefined) patch.reproductiveStatus = body.reproductiveStatus;
    if (body.registrationNumber !== undefined) patch.registrationNumber = emptyToNull(body.registrationNumber);
    if (body.pedigree !== undefined) patch.pedigree = emptyToNull(body.pedigree);
    if (body.geneticTests !== undefined) patch.geneticTests = body.geneticTests;
    if (body.healthScreenings !== undefined) patch.healthScreenings = body.healthScreenings;
    if (body.vetClearance !== undefined) patch.vetClearance = emptyToNull(body.vetClearance);
    if (body.lastSeasonDate !== undefined) {
      patch.lastSeasonDate = body.lastSeasonDate ? new Date(body.lastSeasonDate) : null;
    }
    if (body.littersWhelped !== undefined) patch.littersWhelped = body.littersWhelped;
    if (body.availableFrom !== undefined) {
      patch.availableFrom = body.availableFrom ? new Date(body.availableFrom) : null;
    }
    if (body.matingNotes !== undefined) patch.matingNotes = emptyToNull(body.matingNotes);

    await db
      .insert(breedingRecords)
      .values({ dogId, ...patch })
      .onConflictDoUpdate({
        target: breedingRecords.dogId,
        set: { ...patch, updatedAt: new Date() },
      });

    // Provenance mirror: reproductive status is a sensitive attribute — record
    // that this value came from the owner, with history (ADR 0006).
    if (body.reproductiveStatus !== undefined && body.reproductiveStatus !== null) {
      await applyAttributeUpdates({
        dogId,
        actorUserId: actor.userId,
        updates: [{ key: 'reproductive_status', value: body.reproductiveStatus, confidence: 1, userConfirmed: true }],
        source: 'user',
        requestId: req.requestId,
      });
    }

    // Field names only — breeding/health *values* never go into the audit log.
    await recordAudit({
      actorUserId: actor.userId,
      action: 'dog.breeding_update',
      targetType: 'dog',
      targetId: dogId,
      summary: `updated breeding record (${providedKeys.join(', ')})`,
      requestId: req.requestId,
    });

    return getDogProfileDto(dogId, actor.userId);
  });

  /** Soft delete: history, media links and audit trails stay intact. */
  app.delete('/dogs/:dogId', async (req, reply) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { dogId } = parseParams(dogIdParams, req.params);
    const dog = await assertDogOwner(dogId, actor.userId);

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(dogs)
        .set({ deletedAt: now, status: 'archived', isPrimary: false, updatedAt: now })
        .where(eq(dogs.id, dogId));
      // A deleted dog must never surface in search or to peers.
      await tx.update(dogProfiles).set({ visibility: 'hidden', updatedAt: now }).where(eq(dogProfiles.dogId, dogId));
      // Keep exactly one primary dog when another remains.
      if (dog.isPrimary) {
        const [next] = await tx
          .select({ id: dogs.id })
          .from(dogs)
          .where(and(eq(dogs.ownerId, actor.userId), isNull(dogs.deletedAt), ne(dogs.id, dogId)))
          .orderBy(asc(dogs.createdAt))
          .limit(1);
        if (next) await tx.update(dogs).set({ isPrimary: true, updatedAt: now }).where(eq(dogs.id, next.id));
      }
    });

    await recordAudit({
      actorUserId: actor.userId,
      action: 'dog.delete',
      targetType: 'dog',
      targetId: dogId,
      summary: 'dog profile deleted (soft)',
      requestId: req.requestId,
    });

    reply.status(204).send();
  });
}
