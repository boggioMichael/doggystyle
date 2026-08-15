import { SOCIAL_PROVIDER_IDS, type SocialProviderId } from '@doggystyle/shared';
import { archiveProvider } from './archiveProvider.js';
import { demoProvider } from './demoProvider.js';
import { googlePhotosProvider } from './googlePhotosProvider.js';
import { instagramProvider } from './instagramProvider.js';
import type { SocialProvider } from './types.js';
import { uploadProvider } from './uploadProvider.js';

/**
 * Provider registry. Adding a platform = implement `SocialProvider`, register
 * it here, add its env credentials — no other layer changes
 * (docs/INTEGRATIONS.md "Adding a new provider").
 */
const registry: Record<SocialProviderId, SocialProvider> = {
  demo: demoProvider,
  upload: uploadProvider,
  archive: archiveProvider,
  instagram: instagramProvider,
  google_photos: googlePhotosProvider,
};

export function getProvider(id: SocialProviderId): SocialProvider {
  return registry[id];
}

/** All providers in the shared-domain display order. */
export function allProviders(): SocialProvider[] {
  return SOCIAL_PROVIDER_IDS.map((id) => registry[id]);
}

export type { SocialProvider } from './types.js';
