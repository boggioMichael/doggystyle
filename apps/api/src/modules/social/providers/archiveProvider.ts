import yauzl from 'yauzl';
import { badRequest } from '../../../lib/errors.js';
import type {
  AuthorizeContext,
  AuthorizeResult,
  CallbackContext,
  ExternalMediaItem,
  ExternalProfile,
  LinkedAccount,
  Page,
  SocialAccountRow,
  SocialProvider,
} from './types.js';

/**
 * Archive importer: reads a platform data-export ZIP the user downloaded
 * themselves — the platform-sanctioned path that needs no API credentials.
 *
 * Understands:
 *  - Instagram "Download your information" (legacy `media.json` and the newer
 *    `content/posts_N.json` layout) — captions + timestamps mapped to images,
 *  - Google Takeout for Photos (`.json` sidecars next to each image),
 *  - any plain ZIP of images (jpeg/png/webp), captions optional.
 *
 * Safety limits (docs/INTEGRATIONS.md): max 5 000 entries, 25 MB per entry,
 * 2 GB total uncompressed, zip-slip path rejection, image type verified by
 * magic bytes — the extension alone is never trusted.
 */

const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CAPTION_CHARS = 2000;

const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/;

/* ─────────────────────────────────────────────────────────────────────────────
 * Magic-byte sniffing
 * ───────────────────────────────────────────────────────────────────────────*/

/** Verify image bytes by signature — extensions inside an archive can lie. */
export function sniffImageMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * yauzl plumbing
 * ───────────────────────────────────────────────────────────────────────────*/

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('unreadable zip'));
      else resolve(zip);
    });
  });
}

/** Pull-based entry iterator over yauzl's event API. */
function entryIterator(zip: yauzl.ZipFile): () => Promise<yauzl.Entry | null> {
  let done = false;
  return () =>
    new Promise((resolve, reject) => {
      if (done) {
        resolve(null);
        return;
      }
      const onEntry = (entry: yauzl.Entry): void => {
        cleanup();
        resolve(entry);
      };
      const onEnd = (): void => {
        done = true;
        cleanup();
        resolve(null);
      };
      const onError = (err: Error): void => {
        done = true;
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        zip.removeListener('entry', onEntry);
        zip.removeListener('end', onEnd);
        zip.removeListener('error', onError);
      };
      zip.on('entry', onEntry);
      zip.on('end', onEnd);
      zip.on('error', onError);
      zip.readEntry();
    });
}

/** Read one entry fully, aborting if it exceeds `cap` bytes while inflating. */
function readEntryBuffer(zip: yauzl.ZipFile, entry: yauzl.Entry, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('unreadable zip entry'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > cap) {
          // Declared size can lie (zip bombs) — enforce while inflating too.
          stream.destroy();
          reject(new Error('zip entry exceeds the per-entry size limit'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Path safety & normalisation
 * ───────────────────────────────────────────────────────────────────────────*/

/** Zip-slip guard: any traversal or absolute path aborts the whole import. */
function assertSafeEntryName(name: string): void {
  const unified = name.replaceAll('\\', '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || unified.split('/').includes('..')) {
    throw new Error('archive contains an unsafe entry path');
  }
}

function normalisePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function basename(p: string): string {
  const parts = normalisePath(p).split('/');
  return parts[parts.length - 1] ?? p;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Caption metadata (Instagram / Google Takeout)
 * ───────────────────────────────────────────────────────────────────────────*/

interface CaptionMeta {
  caption: string | null;
  takenAt: Date | null;
}

function cleanCaption(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_CAPTION_CHARS);
  return trimmed || null;
}

function dateFromUnixSeconds(value: unknown): Date | null {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateFromString(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

function setMeta(map: Map<string, CaptionMeta>, path: string, meta: CaptionMeta): void {
  const key = normalisePath(path);
  if (!map.has(key)) map.set(key, meta);
  // Basename fallback: exports sometimes reference media by bare filename.
  const base = basename(path);
  if (base && !map.has(base)) map.set(base, meta);
}

/** Instagram legacy export: media.json → { photos: [{ path, caption, taken_at }] } */
function absorbInstagramLegacy(parsed: unknown, map: Map<string, CaptionMeta>): void {
  if (!parsed || typeof parsed !== 'object') return;
  const photos = (parsed as { photos?: unknown }).photos;
  if (!Array.isArray(photos)) return;
  for (const photo of photos) {
    if (!photo || typeof photo !== 'object') continue;
    const p = photo as { path?: unknown; caption?: unknown; taken_at?: unknown };
    if (typeof p.path !== 'string') continue;
    setMeta(map, p.path, { caption: cleanCaption(p.caption), takenAt: dateFromString(p.taken_at) });
  }
}

/** Instagram JSON export: content/posts_N.json → [{ title, media: [{ uri, title, creation_timestamp }] }] */
function absorbInstagramPosts(parsed: unknown, map: Map<string, CaptionMeta>): void {
  if (!Array.isArray(parsed)) return;
  for (const post of parsed) {
    if (!post || typeof post !== 'object') continue;
    const postTitle = cleanCaption((post as { title?: unknown }).title);
    const media = (post as { media?: unknown }).media;
    if (!Array.isArray(media)) continue;
    for (const item of media) {
      if (!item || typeof item !== 'object') continue;
      const m = item as { uri?: unknown; title?: unknown; creation_timestamp?: unknown };
      if (typeof m.uri !== 'string') continue;
      setMeta(map, m.uri, {
        caption: cleanCaption(m.title) ?? postTitle,
        takenAt: dateFromUnixSeconds(m.creation_timestamp),
      });
    }
  }
}

/** Google Takeout sidecar: IMG_1234.jpg.json (or *.supplemental-metadata.json). */
function absorbTakeoutSidecar(sidecarPath: string, parsed: unknown, map: Map<string, CaptionMeta>): void {
  if (!parsed || typeof parsed !== 'object') return;
  const p = parsed as { description?: unknown; photoTakenTime?: { timestamp?: unknown } | null };
  const target = sidecarPath.replace(/\.supplemental-metadata\.json$/, '').replace(/\.json$/, '');
  if (!IMAGE_EXT_RE.test(target)) return;
  setMeta(map, target, {
    // `title` in a sidecar is usually the filename — only `description` is a caption.
    caption: cleanCaption(p.description),
    takenAt: dateFromUnixSeconds(p.photoTakenTime?.timestamp),
  });
}

/** Pass 1: read only small JSON metadata entries and build path → caption map. */
async function collectCaptionMap(buffer: Buffer): Promise<Map<string, CaptionMeta>> {
  const map = new Map<string, CaptionMeta>();
  const zip = await openZip(buffer);
  try {
    if (zip.entryCount > MAX_ENTRIES) throw new Error(`archive has too many entries (max ${MAX_ENTRIES})`);
    const next = entryIterator(zip);
    for (;;) {
      const entry = await next();
      if (!entry) break;
      const name = entry.fileName;
      if (name.endsWith('/')) continue; // directory
      assertSafeEntryName(name);
      const lower = normalisePath(name);
      if (!lower.endsWith('.json')) continue;
      if (entry.uncompressedSize > MAX_ENTRY_BYTES) continue; // oversized metadata — skip
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readEntryBuffer(zip, entry, MAX_ENTRY_BYTES)).toString('utf8'));
      } catch {
        continue; // not valid JSON — ignore, it is only metadata
      }
      if (basename(lower) === 'media.json') absorbInstagramLegacy(parsed, map);
      else if (/(^|\/)posts_\d+\.json$/.test(lower)) absorbInstagramPosts(parsed, map);
      else absorbTakeoutSidecar(lower, parsed, map);
    }
  } finally {
    zip.close();
  }
  return map;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The parser
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Stream importable images out of an export ZIP. Two passes over the (already
 * in-memory) buffer: pass 1 collects caption metadata, pass 2 lazily inflates
 * one image at a time — the full uncompressed content never sits in memory at
 * once.
 */
export async function* parseArchive(buffer: Buffer): AsyncGenerator<ExternalMediaItem> {
  const captions = await collectCaptionMap(buffer);

  const zip = await openZip(buffer);
  let totalBytes = 0;
  try {
    if (zip.entryCount > MAX_ENTRIES) throw new Error(`archive has too many entries (max ${MAX_ENTRIES})`);
    const next = entryIterator(zip);
    for (;;) {
      const entry = await next();
      if (!entry) break;
      const name = entry.fileName;
      if (name.endsWith('/')) continue; // directory
      assertSafeEntryName(name);
      const lower = normalisePath(name);
      if (!IMAGE_EXT_RE.test(lower)) continue;
      if (entry.uncompressedSize > MAX_ENTRY_BYTES) continue; // oversized image — skip, keep the rest
      totalBytes += entry.uncompressedSize;
      if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new Error('archive exceeds the total uncompressed size limit');
      }

      const data = await readEntryBuffer(zip, entry, MAX_ENTRY_BYTES);
      const mime = sniffImageMime(data);
      if (!mime) continue; // extension lied about the content — drop it

      const meta = captions.get(lower) ?? captions.get(basename(lower));
      yield {
        externalId: name,
        buffer: data,
        mimeType: mime,
        caption: meta?.caption ?? null,
        takenAt: meta?.takenAt ?? null,
      };
    }
  } finally {
    zip.close();
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Provider
 * ───────────────────────────────────────────────────────────────────────────*/

export const archiveProvider: SocialProvider = {
  id: 'archive',

  capabilities: { media: true, captions: true, profile: false, refresh: false },

  descriptor() {
    return {
      label: 'Import a data export',
      description:
        'Upload the ZIP you downloaded from Instagram ("Download your information"), Facebook, or Google Takeout. Captions come along for the ride.',
      kind: 'archive' as const,
      available: true,
      unavailableReason: null,
    };
  },

  async authorize(_ctx: AuthorizeContext): Promise<AuthorizeResult> {
    return {
      instructions:
        'Request a data export from your platform (Instagram: Settings → Download your information, JSON format), then upload the ZIP here.',
    };
  },

  async handleCallback(_ctx: CallbackContext): Promise<LinkedAccount> {
    throw badRequest('The archive source has no OAuth callback.');
  },

  async refreshToken(acct: SocialAccountRow): Promise<LinkedAccount> {
    // No tokens involved — mirror the stored row unchanged.
    return {
      externalId: acct.externalId,
      handle: acct.handle,
      displayName: acct.displayName,
      accessTokenEnc: null,
      refreshTokenEnc: null,
      scopes: acct.scopes,
      expiresAt: null,
    };
  },

  async getProfile(acct: SocialAccountRow): Promise<ExternalProfile> {
    return { externalId: acct.externalId, handle: null, displayName: 'Data export' };
  },

  async getMedia(_acct: SocialAccountRow, _cursor?: string): Promise<Page<ExternalMediaItem>> {
    // Archives are parsed at upload time via `parseArchive` — the buffer is
    // request-scoped, so there is nothing to fetch here later.
    return { items: [], nextCursor: null };
  },

  async revoke(_acct: SocialAccountRow): Promise<void> {
    // Nothing external to revoke.
  },
};
