import { env } from '../../../config/env.js';
import { decryptSecret, encryptSecret } from '../../../lib/crypto.js';
import { logger } from '../../../lib/logger.js';
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
 * Instagram adapter — "Instagram API with Instagram Login", the only compliant
 * path since Basic Display was shut down (Dec 2024). Works for Business and
 * Creator accounts with the `instagram_business_basic` scope; personal
 * accounts are routed to the archive importer instead (docs/INTEGRATIONS.md).
 *
 * Feature-flagged: the adapter only reports itself available when
 * INSTAGRAM_APP_ID + INSTAGRAM_APP_SECRET are configured.
 *
 * Tokens are encrypted with `encryptSecret` before they ever leave this file;
 * plaintext exists only inside these functions and is never logged.
 */

const IG_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH_BASE = 'https://graph.instagram.com';

const FETCH_TIMEOUT_MS = 15_000;
const MEDIA_PAGE_SIZE = 25;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const credentialsConfigured = (): boolean => Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);

const redirectUri = (): string => `${env.PUBLIC_URL}/api/social/instagram/callback`;

/* ─────────────────────────────────────────────────────────────────────────────
 * HTTP helpers
 * ───────────────────────────────────────────────────────────────────────────*/

/** Response bodies from the platform are never included in thrown errors. */
async function igJson<T>(input: URL | string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`instagram request failed (${res.status})`);
  return (await res.json()) as T;
}

/** Fetch image bytes from a (short-lived, CDN-signed) media_url. */
async function fetchImageBytes(url: string): Promise<{ buffer: Buffer; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const declared = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
    return { buffer, mime: res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg' };
  } catch (err) {
    logger.warn({ err }, 'instagram media byte fetch failed — skipping item');
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Provider
 * ───────────────────────────────────────────────────────────────────────────*/

interface IgTokenResponse {
  access_token?: string;
  user_id?: string | number;
}

interface IgLongLivedResponse {
  access_token?: string;
  expires_in?: number;
}

interface IgMediaListResponse {
  data?: Array<{
    id?: string;
    caption?: string;
    media_type?: string;
    media_url?: string;
    timestamp?: string;
  }>;
  paging?: { cursors?: { after?: string }; next?: string };
}

export const instagramProvider: SocialProvider = {
  id: 'instagram',

  capabilities: { media: true, captions: true, profile: true, refresh: true },

  descriptor() {
    const available = credentialsConfigured();
    return {
      label: 'Instagram',
      description: 'Connect a Business or Creator Instagram account and import your dog photos with captions.',
      kind: 'oauth' as const,
      available,
      unavailableReason: available
        ? null
        : 'Not enabled on this server: requires a Meta developer app and App Review for instagram_business_basic ' +
          '(see docs/INTEGRATIONS.md). Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to enable. ' +
          'Personal accounts have no supported media API — use the data-export import instead.',
    };
  },

  async authorize(ctx: AuthorizeContext): Promise<AuthorizeResult> {
    if (!credentialsConfigured()) throw new Error('instagram credentials are not configured');
    const url = new URL(IG_AUTHORIZE_URL);
    url.searchParams.set('client_id', env.INSTAGRAM_APP_ID);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('scope', 'instagram_business_basic');
    url.searchParams.set('response_type', 'code');
    if (ctx.state) url.searchParams.set('state', ctx.state);
    return { redirectUrl: url.toString() };
  },

  async handleCallback(ctx: CallbackContext): Promise<LinkedAccount> {
    if (!credentialsConfigured()) throw new Error('instagram credentials are not configured');

    // Exchange the code for a short-lived token.
    const form = new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      client_secret: env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code: ctx.code,
    });
    const token = await igJson<IgTokenResponse>(IG_TOKEN_URL, { method: 'POST', body: form });
    if (!token.access_token || token.user_id === undefined || token.user_id === null) {
      throw new Error('instagram token exchange returned an unexpected payload');
    }

    // Upgrade to a 60-day token. Best effort — the short-lived token still works.
    let accessToken = token.access_token;
    let expiresAt: Date | null = null;
    try {
      const llUrl = new URL(`${IG_GRAPH_BASE}/access_token`);
      llUrl.searchParams.set('grant_type', 'ig_exchange_token');
      llUrl.searchParams.set('client_secret', env.INSTAGRAM_APP_SECRET);
      llUrl.searchParams.set('access_token', accessToken);
      const ll = await igJson<IgLongLivedResponse>(llUrl);
      if (ll.access_token) {
        accessToken = ll.access_token;
        if (ll.expires_in) expiresAt = new Date(Date.now() + ll.expires_in * 1000);
      }
    } catch (err) {
      logger.warn({ err }, 'instagram long-lived token exchange failed — keeping short-lived token');
    }

    // Handle lookup, also best effort.
    let username: string | null = null;
    try {
      const meUrl = new URL(`${IG_GRAPH_BASE}/me`);
      meUrl.searchParams.set('fields', 'id,username');
      meUrl.searchParams.set('access_token', accessToken);
      const me = await igJson<{ username?: string }>(meUrl);
      username = me.username ?? null;
    } catch (err) {
      logger.warn({ err }, 'instagram profile fetch failed — storing account without handle');
    }

    return {
      externalId: String(token.user_id),
      handle: username ? `@${username}` : null,
      displayName: username,
      // Encrypted before storage — the plaintext token dies with this scope.
      accessTokenEnc: encryptSecret(accessToken),
      refreshTokenEnc: null, // this flow refreshes the access token in place
      scopes: ['instagram_business_basic'],
      expiresAt,
    };
  },

  async refreshToken(acct: SocialAccountRow): Promise<LinkedAccount> {
    const token = decryptSecret(acct.accessTokenEnc);
    if (!token) throw new Error('no usable instagram token — the account must be reconnected');
    const url = new URL(`${IG_GRAPH_BASE}/refresh_access_token`);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', token);
    const refreshed = await igJson<IgLongLivedResponse>(url);
    if (!refreshed.access_token) throw new Error('instagram token refresh returned an unexpected payload');
    return {
      externalId: acct.externalId,
      handle: acct.handle,
      displayName: acct.displayName,
      accessTokenEnc: encryptSecret(refreshed.access_token),
      refreshTokenEnc: null,
      scopes: acct.scopes,
      expiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : acct.expiresAt,
    };
  },

  async getProfile(acct: SocialAccountRow): Promise<ExternalProfile> {
    const token = decryptSecret(acct.accessTokenEnc);
    if (!token) throw new Error('no usable instagram token — the account must be reconnected');
    const url = new URL(`${IG_GRAPH_BASE}/me`);
    url.searchParams.set('fields', 'id,username');
    url.searchParams.set('access_token', token);
    const me = await igJson<{ id?: string; username?: string }>(url);
    return {
      externalId: me.id ?? acct.externalId,
      handle: me.username ? `@${me.username}` : acct.handle,
      displayName: me.username ?? acct.displayName,
    };
  },

  async getMedia(acct: SocialAccountRow, cursor?: string): Promise<Page<ExternalMediaItem>> {
    const token = decryptSecret(acct.accessTokenEnc);
    if (!token) throw new Error('no usable instagram token — the account must be reconnected');

    const url = new URL(`${IG_GRAPH_BASE}/me/media`);
    url.searchParams.set('fields', 'id,caption,media_type,media_url,timestamp');
    url.searchParams.set('limit', String(MEDIA_PAGE_SIZE));
    url.searchParams.set('access_token', token);
    if (cursor) url.searchParams.set('after', cursor);

    const page = await igJson<IgMediaListResponse>(url);

    const items: ExternalMediaItem[] = [];
    for (const m of page.data ?? []) {
      // IMAGE only — videos and carousel containers are out of scope for import.
      if (!m.id || m.media_type !== 'IMAGE' || !m.media_url) continue;
      const bytes = await fetchImageBytes(m.media_url);
      if (!bytes) continue; // expired CDN link or oversized — skip, keep the rest
      items.push({
        externalId: m.id,
        buffer: bytes.buffer,
        mimeType: bytes.mime,
        caption: m.caption ?? null,
        takenAt: m.timestamp ? new Date(m.timestamp) : null,
      });
    }

    // Only report a cursor when the platform says there is a next page.
    const nextCursor = page.paging?.next ? (page.paging.cursors?.after ?? null) : null;
    return { items, nextCursor };
  },

  async revoke(_acct: SocialAccountRow): Promise<void> {
    // This login flow has no server-side revocation endpoint. The user removes
    // access at instagram.com → Settings → Apps and websites; our side marks
    // the account revoked and stops using the token.
    logger.info('instagram revoke: no remote endpoint — local revocation only');
  },
};
