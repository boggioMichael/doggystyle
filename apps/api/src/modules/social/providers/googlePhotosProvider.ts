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
 * Google Photos adapter — Picker API flow, the only compliant path since the
 * Library API's broad read scopes were restricted (31 March 2025): apps may
 * only read media the user explicitly hands over through a Picker session
 * (docs/INTEGRATIONS.md).
 *
 * Feature-flagged: available only when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
 * are configured. OAuth linking is fully implemented; media listing is a stub
 * because a Picker session must be created interactively in the web UI — a
 * background job cannot pick photos on the user's behalf, by design.
 *
 * Tokens are encrypted with `encryptSecret` before they leave this file.
 */

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

const FETCH_TIMEOUT_MS = 15_000;

const credentialsConfigured = (): boolean => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

const redirectUri = (): string => `${env.PUBLIC_URL}/api/social/google_photos/callback`;

/* ─────────────────────────────────────────────────────────────────────────────
 * HTTP helpers
 * ───────────────────────────────────────────────────────────────────────────*/

/** Response bodies from the platform are never included in thrown errors. */
async function googleJson<T>(input: URL | string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`google request failed (${res.status})`);
  return (await res.json()) as T;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Provider
 * ───────────────────────────────────────────────────────────────────────────*/

export const googlePhotosProvider: SocialProvider = {
  id: 'google_photos',

  capabilities: { media: true, captions: false, profile: false, refresh: true },

  descriptor() {
    const available = credentialsConfigured();
    return {
      label: 'Google Photos',
      description: 'Pick photos of your dog from Google Photos. You choose exactly which photos we can see.',
      kind: 'oauth' as const,
      available,
      unavailableReason: available
        ? null
        : 'Not enabled on this server: requires a Google Cloud project with the Photos Picker API and an OAuth ' +
          'consent screen (see docs/INTEGRATIONS.md). Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable.',
    };
  },

  async authorize(ctx: AuthorizeContext): Promise<AuthorizeResult> {
    if (!credentialsConfigured()) throw new Error('google credentials are not configured');
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', PICKER_SCOPE);
    // Offline access → refresh token, so a picked session can outlive the hour.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    if (ctx.state) url.searchParams.set('state', ctx.state);
    return { redirectUrl: url.toString() };
  },

  async handleCallback(ctx: CallbackContext): Promise<LinkedAccount> {
    if (!credentialsConfigured()) throw new Error('google credentials are not configured');
    const form = new URLSearchParams({
      code: ctx.code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    });
    const token = await googleJson<GoogleTokenResponse>(GOOGLE_TOKEN_URL, { method: 'POST', body: form });
    if (!token.access_token) throw new Error('google token exchange returned an unexpected payload');

    return {
      // The picker scope carries no profile identity — one linked account per
      // user is exactly what we want, so key it on our own user id.
      externalId: `google-photos-${ctx.userId}`,
      handle: null,
      displayName: 'Google Photos',
      accessTokenEnc: encryptSecret(token.access_token),
      refreshTokenEnc: token.refresh_token ? encryptSecret(token.refresh_token) : null,
      scopes: [PICKER_SCOPE],
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
    };
  },

  async refreshToken(acct: SocialAccountRow): Promise<LinkedAccount> {
    const refresh = decryptSecret(acct.refreshTokenEnc);
    if (!refresh) throw new Error('no usable google refresh token — the account must be reconnected');
    const form = new URLSearchParams({
      refresh_token: refresh,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    });
    const token = await googleJson<GoogleTokenResponse>(GOOGLE_TOKEN_URL, { method: 'POST', body: form });
    if (!token.access_token) throw new Error('google token refresh returned an unexpected payload');
    return {
      externalId: acct.externalId,
      handle: acct.handle,
      displayName: acct.displayName,
      accessTokenEnc: encryptSecret(token.access_token),
      refreshTokenEnc: acct.refreshTokenEnc, // refresh token is long-lived; keep it
      scopes: acct.scopes,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : acct.expiresAt,
    };
  },

  async getProfile(acct: SocialAccountRow): Promise<ExternalProfile> {
    // The picker scope exposes no profile endpoint — echo the stored identity.
    return { externalId: acct.externalId, handle: null, displayName: 'Google Photos' };
  },

  async getMedia(acct: SocialAccountRow, _cursor?: string): Promise<Page<ExternalMediaItem>> {
    // Picker API flow: media items only become readable after the user creates
    // a picking session in an interactive UI and selects photos there. A
    // background import cannot do that on their behalf (that is the point of
    // the Picker model), so this returns an empty page until the web UI ships
    // a picker session flow.
    logger.info(
      { socialAccountId: acct.id },
      'google photos: picker requires an interactive picking session in the UI — background import returns no items',
    );
    return { items: [], nextCursor: null };
  },

  async revoke(acct: SocialAccountRow): Promise<void> {
    // Best effort: revoking either token invalidates the whole grant.
    const token = decryptSecret(acct.refreshTokenEnc) ?? decryptSecret(acct.accessTokenEnc);
    if (!token) return;
    const url = new URL(GOOGLE_REVOKE_URL);
    url.searchParams.set('token', token);
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`google token revoke failed (${res.status})`);
  },
};
