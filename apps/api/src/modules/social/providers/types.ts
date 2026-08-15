import type { SocialProviderId } from '@doggystyle/shared';
import type { socialAccounts } from '../../../db/schema.js';

/**
 * The SocialProvider adapter contract (ARCHITECTURE.md §8).
 *
 * Every media source — including the offline demo and the plain file upload —
 * implements this one interface, so the import pipeline, the connect flow and
 * the descriptors endpoint never special-case a platform.
 *
 * Token handling rule: adapters receive and return ONLY encrypted token
 * material (`encryptSecret` ciphertext). Plaintext tokens exist transiently
 * inside adapter functions and are never stored, logged, or serialised.
 */

export type SocialAccountRow = typeof socialAccounts.$inferSelect;

export interface ProviderCapabilities {
  /** Can enumerate media items for a linked account. */
  media: boolean;
  /** Media items carry user-written captions. */
  captions: boolean;
  /** Can fetch handle/display-name for a linked account. */
  profile: boolean;
  /** Access tokens can be refreshed without user interaction. */
  refresh: boolean;
}

/** Static description of the provider, merged with per-user state by the service. */
export interface ProviderDescriptor {
  label: string;
  description: string;
  kind: 'oauth' | 'upload' | 'archive' | 'demo';
  available: boolean;
  /** Rendered verbatim to the user when `available` is false. */
  unavailableReason: string | null;
}

export interface AuthorizeContext {
  userId: string;
  /**
   * Opaque anti-CSRF state minted by the service. OAuth providers must echo it
   * back through the provider's redirect so the callback can verify the flow
   * was started by this same signed-in user.
   */
  state?: string;
}

/** Either a browser redirect (OAuth) or inline instructions (upload/archive/demo). */
export interface AuthorizeResult {
  redirectUrl?: string;
  instructions?: string;
}

export interface CallbackContext {
  userId: string;
  code: string;
  state?: string;
}

/**
 * What the service persists into `social_accounts`. Token fields are already
 * AES-256-GCM ciphertext (`encryptSecret`) — the service stores them as-is.
 */
export interface LinkedAccount {
  externalId: string;
  handle: string | null;
  displayName: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  scopes: string[];
  expiresAt: Date | null;
}

export interface ExternalProfile {
  externalId: string;
  handle: string | null;
  displayName: string | null;
}

/**
 * One importable media item. Providers supply either raw bytes (`buffer`) or a
 * short-lived `url` the import service fetches. `mimeType` is an optional hint;
 * when absent the importer sniffs magic bytes before ingesting.
 */
export interface ExternalMediaItem {
  externalId: string;
  buffer?: Buffer;
  url?: string;
  caption?: string | null;
  takenAt?: Date | null;
  mimeType?: string;
}

export interface Page<T> {
  items: T[];
  /** Pass back into `getMedia` to fetch the next page; null/absent = done. */
  nextCursor?: string | null;
}

export interface SocialProvider {
  readonly id: SocialProviderId;
  readonly capabilities: ProviderCapabilities;

  /** Evaluated at call time so env-driven availability stays current. */
  descriptor(): ProviderDescriptor;

  authorize(ctx: AuthorizeContext): Promise<AuthorizeResult>;

  handleCallback(ctx: CallbackContext): Promise<LinkedAccount>;

  refreshToken(acct: SocialAccountRow): Promise<LinkedAccount>;

  getProfile(acct: SocialAccountRow): Promise<ExternalProfile>;

  getMedia(acct: SocialAccountRow, cursor?: string): Promise<Page<ExternalMediaItem>>;

  /** Best-effort remote de-authorisation. Callers treat failures as non-fatal. */
  revoke(acct: SocialAccountRow): Promise<void>;
}
