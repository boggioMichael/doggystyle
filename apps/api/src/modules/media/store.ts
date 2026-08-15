import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../../config/env.js';
import { newId, sha256Hex } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';

/**
 * Filesystem media store.
 *
 * Layout: MEDIA_DIR/<userId>/<uuid>.webp (+ <uuid>.thumb.webp). Storage keys are
 * relative paths recorded in the database; nothing under MEDIA_DIR is ever
 * served as a static directory — every read goes through an authorised route
 * that calls `absolutePath` (which enforces the traversal guard below).
 */

const MAIN_MAX_EDGE = 1600; // px, longest side
const MAIN_QUALITY = 82;
const THUMB_MAX_EDGE = 320;
const THUMB_QUALITY = 70;

export interface SavedMediaFile {
  /** Relative path inside MEDIA_DIR, e.g. "<userId>/<uuid>.webp". */
  storageKey: string;
  thumbKey: string;
  width: number | null;
  height: number | null;
  /** Byte size of the ORIGINAL buffer (not the re-encode). */
  bytes: number;
  /** SHA-256 hex of the ORIGINAL buffer — the per-user dedupe key. */
  sha256: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Path resolution
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Resolve a storage key to an absolute path, refusing anything that escapes
 * MEDIA_DIR. Keys are server-generated, but a hostile value that somehow lands
 * in the database ("../../secrets") must never turn into a file read.
 */
function absolutePath(storageKey: string): string {
  const root = path.resolve(env.mediaDir);
  const resolved = path.resolve(root, storageKey);
  // Traversal guard: the resolved path must sit strictly inside the media root.
  if (!resolved.startsWith(root + path.sep)) throw notFound('File not found.');
  return resolved;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Store
 * ───────────────────────────────────────────────────────────────────────────*/

export const mediaStore = {
  /**
   * Persist one image as a scrubbed main rendition + thumbnail.
   *
   * The original buffer is NEVER written to disk. Both renditions are produced
   * by a full re-encode to WebP, which drops every metadata block (EXIF, GPS,
   * XMP, ICC) — this re-encode IS the EXIF/GPS scrub, so a photo taken at home
   * cannot leak its coordinates to a peer. `.rotate()` bakes the EXIF
   * orientation into the pixels first so the scrub does not sideways-flip
   * phone photos.
   */
  async save(args: { userId: string; buffer: Buffer; mimeType: string }): Promise<SavedMediaFile> {
    const { userId, buffer } = args;
    const id = newId();
    // Forward slashes in keys keep database values platform-independent;
    // path.resolve normalises them on Windows.
    const storageKey = `${userId}/${id}.webp`;
    const thumbKey = `${userId}/${id}.thumb.webp`;

    await mkdir(path.join(path.resolve(env.mediaDir), userId), { recursive: true });

    // Dimensions of the ORIGINAL image. EXIF orientations 5-8 rotate by 90°,
    // so reported width/height are swapped to match what a viewer sees.
    const meta = await sharp(buffer).metadata();
    const sideways = (meta.orientation ?? 1) >= 5;
    const width = (sideways ? meta.height : meta.width) ?? null;
    const height = (sideways ? meta.width : meta.height) ?? null;

    const mainAbs = absolutePath(storageKey);
    const thumbAbs = absolutePath(thumbKey);

    await sharp(buffer)
      .rotate() // bake EXIF orientation into pixels before metadata is dropped
      .resize(MAIN_MAX_EDGE, MAIN_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: MAIN_QUALITY })
      .toFile(mainAbs);

    try {
      await sharp(buffer)
        .rotate()
        .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY })
        .toFile(thumbAbs);
    } catch (err) {
      // Never leave a half-saved pair behind.
      await unlink(mainAbs).catch(() => {});
      throw err;
    }

    // bytes/sha256 describe the ORIGINAL upload: the dedupe key must match what
    // a client re-uploads, not our re-encode (which is not byte-stable).
    return { storageKey, thumbKey, width, height, bytes: buffer.length, sha256: sha256Hex(buffer) };
  },

  absolutePath,

  /** Best-effort unlink. Missing files and races are not errors. */
  async delete(storageKey?: string | null): Promise<void> {
    if (!storageKey) return;
    try {
      await unlink(absolutePath(storageKey));
    } catch {
      // best-effort by design
    }
  },
};
