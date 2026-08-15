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
 * Direct upload "provider". There is no external account and no fetch loop —
 * the actual bytes arrive through `POST /api/media/upload` — but modelling it
 * as a provider keeps the connect UI and descriptors endpoint uniform.
 */
export const uploadProvider: SocialProvider = {
  id: 'upload',

  capabilities: { media: false, captions: true, profile: false, refresh: false },

  descriptor() {
    return {
      label: 'Upload photos',
      description: 'Add photos of your dog straight from this device. Works everywhere, no account needed.',
      kind: 'upload' as const,
      available: true,
      unavailableReason: null,
    };
  },

  async authorize(_ctx: AuthorizeContext): Promise<AuthorizeResult> {
    return {
      instructions: 'Pick photos of your dog from this device — they upload directly, nothing to connect.',
    };
  },

  async handleCallback(_ctx: CallbackContext): Promise<LinkedAccount> {
    throw badRequest('The upload source has no OAuth callback.');
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
    return { externalId: acct.externalId, handle: null, displayName: 'Direct upload' };
  },

  async getMedia(_acct: SocialAccountRow, _cursor?: string): Promise<Page<ExternalMediaItem>> {
    // Uploaded files are ingested by the media module at upload time.
    return { items: [], nextCursor: null };
  },

  async revoke(_acct: SocialAccountRow): Promise<void> {
    // Nothing external to revoke.
  },
};
