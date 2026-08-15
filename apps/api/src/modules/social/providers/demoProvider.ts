import sharp from 'sharp';
import { env } from '../../../config/env.js';
import { sha256Hex } from '../../../lib/crypto.js';
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
 * Demo provider: simulates an authorised social account with a synthetic photo
 * set, so the entire connect → import → cluster → profile pipeline runs with
 * zero external credentials.
 *
 * Everything is deterministic per user (seed = first 8 hex of sha256(userId)):
 * the same user always gets the same dog name, palette and photos, which makes
 * demo walkthroughs and tests reproducible. Images are composed as SVG and
 * rendered to ~800×600 JPEG through sharp — no assets on disk, no network.
 *
 * The set is intentionally mixed: 5 photos of "the user's dog" sharing one
 * per-user base palette (so `clusterSignatures` groups them into ONE cluster),
 * plus 2 obviously-non-dog images (skyline, food) that the classifier stage
 * gets to reject or down-score — exercising the same paths a real social feed
 * would.
 */

const DOG_COUNT = 5;
const NON_DOG_COUNT = 2;

const DEMO_DOG_NAMES = [
  'Rex',
  'Luna',
  'Max',
  'Bella',
  'Charlie',
  'Daisy',
  'Rocky',
  'Molly',
  'Buddy',
  'Ruby',
  'Milo',
  'Rosie',
] as const;

/** Aliases the heuristic breed lexicon recognises — captions become breed hints. */
const DEMO_BREED_ALIASES = ['golden', 'labrador', 'border collie', 'beagle', 'corgi', 'poodle'] as const;

export interface DemoIdentity {
  /** First 8 hex chars of sha256(userId). */
  seedHex: string;
  seedInt: number;
  name: string;
  breedAlias: string;
}

/** Deterministic per-user identity: dog name + breed hint + palette seed. */
export function demoIdentity(userId: string): DemoIdentity {
  const seedHex = sha256Hex(userId).slice(0, 8);
  const seedInt = Number.parseInt(seedHex, 16) >>> 0;
  const name = DEMO_DOG_NAMES[seedInt % DEMO_DOG_NAMES.length] ?? 'Rex';
  const breedAlias = DEMO_BREED_ALIASES[(seedInt >>> 4) % DEMO_BREED_ALIASES.length] ?? 'golden';
  return { seedHex, seedInt, name, breedAlias };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Deterministic pseudo-randomness
 * ───────────────────────────────────────────────────────────────────────────*/

/** mulberry32 — tiny seeded PRNG; identical sequence for identical seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoPalette {
  furHue: number;
  furSat: number;
  furLight: number;
  skyHue: number;
  grassHue: number;
}

/** One base palette per user — shared by all 5 dog images so they cluster together. */
function paletteFor(seedInt: number): DemoPalette {
  const rand = mulberry32(seedInt);
  return {
    furHue: 18 + Math.floor(rand() * 30), // warm browns/tans/creams
    furSat: 38 + Math.floor(rand() * 28),
    furLight: 34 + Math.floor(rand() * 28),
    skyHue: 192 + Math.floor(rand() * 18), // soft outdoor blues
    grassHue: 95 + Math.floor(rand() * 22), // greens
  };
}

const hsl = (h: number, s: number, l: number): string => `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;

/* ─────────────────────────────────────────────────────────────────────────────
 * SVG composition
 * ───────────────────────────────────────────────────────────────────────────*/

const W = 800;
const H = 600;

/**
 * Stylised dog on a soft outdoor background. Pose and background hue vary
 * slightly per index — enough that the photos look distinct, little enough
 * that the visual-signature histograms still land in the same cluster.
 */
function dogSvg(palette: DemoPalette, index: number): string {
  const bgDelta = (index - 2) * 3;
  const dx = (index - 2) * 28;
  const flip = index % 2 === 0 ? 1 : -1;
  const tailAngle = -32 + index * 13;
  const headDy = ((index % 3) - 1) * 9;
  const sunX = 110 + index * 42;

  const fur = hsl(palette.furHue, palette.furSat, palette.furLight);
  const furDark = hsl(palette.furHue, palette.furSat, Math.max(12, palette.furLight - 13));
  const furLightTone = hsl(palette.furHue, Math.max(18, palette.furSat - 10), Math.min(88, palette.furLight + 16));
  const skyTop = hsl(palette.skyHue + bgDelta, 52, 82);
  const skyBottom = hsl(palette.skyHue + bgDelta, 42, 70);
  const grass = hsl(palette.grassHue + bgDelta, 46, 52);
  const grassLight = hsl(palette.grassHue + bgDelta, 42, 60);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${skyTop}"/>
      <stop offset="1" stop-color="${skyBottom}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <circle cx="${sunX}" cy="92" r="46" fill="hsl(48, 92%, 82%)" opacity="0.9"/>
  <g fill="#ffffff" opacity="0.65">
    <ellipse cx="${560 - index * 30}" cy="120" rx="70" ry="22"/>
    <ellipse cx="${620 - index * 30}" cy="136" rx="52" ry="18"/>
  </g>
  <ellipse cx="400" cy="600" rx="620" ry="200" fill="${grassLight}"/>
  <rect y="470" width="${W}" height="130" fill="${grass}"/>
  <g transform="translate(${400 + dx} 0) scale(${flip} 1) translate(-400 0)">
    <!-- tail -->
    <ellipse cx="278" cy="352" rx="56" ry="16" fill="${furDark}" transform="rotate(${tailAngle} 278 352)"/>
    <!-- legs -->
    <rect x="318" y="398" width="26" height="82" rx="12" fill="${fur}"/>
    <rect x="362" y="404" width="26" height="78" rx="12" fill="${furDark}"/>
    <rect x="432" y="404" width="26" height="78" rx="12" fill="${furDark}"/>
    <rect x="472" y="398" width="26" height="82" rx="12" fill="${fur}"/>
    <!-- body + chest -->
    <ellipse cx="400" cy="372" rx="124" ry="70" fill="${fur}"/>
    <circle cx="478" cy="352" r="54" fill="${fur}"/>
    <!-- head -->
    <circle cx="522" cy="${292 + headDy}" r="56" fill="${fur}"/>
    <ellipse cx="497" cy="${246 + headDy}" rx="18" ry="34" fill="${furDark}" transform="rotate(-24 497 ${246 + headDy})"/>
    <ellipse cx="548" cy="${244 + headDy}" rx="18" ry="34" fill="${furDark}" transform="rotate(22 548 ${244 + headDy})"/>
    <ellipse cx="560" cy="${308 + headDy}" rx="30" ry="21" fill="${furLightTone}"/>
    <circle cx="583" cy="${302 + headDy}" r="8" fill="#3a2e28"/>
    <circle cx="534" cy="${283 + headDy}" r="6" fill="#2c2420"/>
  </g>
</svg>`;
}

/** Obviously-non-dog #1: a flat geometric skyline in cool blue-greys. */
function skylineSvg(seedInt: number): string {
  const rand = mulberry32(seedInt ^ 0x51ab);
  let buildings = '';
  let x = 0;
  while (x < W) {
    const bw = 60 + Math.floor(rand() * 70);
    const bh = 160 + Math.floor(rand() * 260);
    const hue = 208 + Math.floor(rand() * 18);
    buildings += `<rect x="${x}" y="${H - 60 - bh}" width="${bw}" height="${bh}" fill="${hsl(hue, 38, 34 + Math.floor(rand() * 18))}"/>`;
    // A few lit windows
    for (let wy = H - 60 - bh + 24; wy < H - 100; wy += 46) {
      if (rand() > 0.5) buildings += `<rect x="${x + 12}" y="${wy}" width="12" height="16" fill="hsl(48, 80%, 72%)"/>`;
    }
    x += bw + 10;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="hsl(214, 34%, 76%)"/>
  ${buildings}
  <rect y="${H - 60}" width="${W}" height="60" fill="hsl(216, 30%, 26%)"/>
</svg>`;
}

/** Obviously-non-dog #2: food-ish flat colours (plate on a teal table). */
function foodSvg(seedInt: number): string {
  const rand = mulberry32(seedInt ^ 0xf00d);
  let toppings = '';
  for (let i = 0; i < 9; i += 1) {
    const angle = rand() * Math.PI * 2;
    const r = 40 + rand() * 110;
    toppings += `<circle cx="${Math.round(400 + Math.cos(angle) * r)}" cy="${Math.round(300 + Math.sin(angle) * r * 0.8)}" r="${10 + Math.floor(rand() * 10)}" fill="${rand() > 0.5 ? 'hsl(52, 82%, 60%)' : 'hsl(120, 38%, 38%)'}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="hsl(176, 44%, 58%)"/>
  <ellipse cx="400" cy="310" rx="290" ry="230" fill="hsl(40, 30%, 94%)"/>
  <ellipse cx="400" cy="305" rx="230" ry="180" fill="hsl(14, 74%, 54%)"/>
  ${toppings}
</svg>`;
}

async function renderJpeg(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).jpeg({ quality: 84 }).toBuffer();
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Captions
 * ───────────────────────────────────────────────────────────────────────────*/

/** Two captions carry breed hints so profile extraction has something to find. */
function dogCaptions(identity: DemoIdentity): string[] {
  const { name, breedAlias } = identity;
  return [
    `Morning zoomies with ${name}`,
    `${name} loves the beach`,
    `Our ${breedAlias} boy ${name} after his walk`,
    `${name} the ${breedAlias} making new friends at the dog park`,
    `Nap time for ${name} — full of beans all morning`,
  ];
}

const NON_DOG_CAPTIONS = ['Skyline from the office', 'Saturday brunch, no regrets'];

/* ─────────────────────────────────────────────────────────────────────────────
 * Provider
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * The demo "account" is derived from the user id rather than granted by anyone,
 * so there is no token to store and nothing to refresh.
 */
function linkedAccountFor(userId: string): LinkedAccount {
  const identity = demoIdentity(userId);
  return {
    externalId: `demo-${userId}`,
    handle: `@${identity.name.toLowerCase()}`,
    displayName: `${identity.name}'s human (demo)`,
    accessTokenEnc: null,
    refreshTokenEnc: null,
    scopes: ['demo:media'],
    expiresAt: null,
  };
}

export const demoProvider: SocialProvider = {
  id: 'demo',

  capabilities: { media: true, captions: true, profile: true, refresh: false },

  descriptor() {
    return {
      label: 'Demo account',
      description: 'Simulates a connected social account with a ready-made photo set. No credentials needed.',
      kind: 'demo' as const,
      available: env.DEMO_MODE,
      unavailableReason: env.DEMO_MODE ? null : 'Demo mode is switched off on this server.',
    };
  },

  async authorize(_ctx: AuthorizeContext): Promise<AuthorizeResult> {
    return {
      instructions:
        'Demo mode simulates an already-authorised account — connecting starts an import of a sample photo set immediately.',
    };
  },

  async handleCallback(ctx: CallbackContext): Promise<LinkedAccount> {
    // The demo flow has no OAuth leg; a "callback" just re-derives the account.
    return linkedAccountFor(ctx.userId);
  },

  async refreshToken(acct: SocialAccountRow): Promise<LinkedAccount> {
    // Nothing to refresh — the demo account is derived, not granted.
    return linkedAccountFor(acct.userId);
  },

  async getProfile(acct: SocialAccountRow): Promise<ExternalProfile> {
    const identity = demoIdentity(acct.userId);
    return {
      externalId: `demo-${acct.userId}`,
      handle: `@${identity.name.toLowerCase()}`,
      displayName: identity.name,
    };
  },

  async getMedia(acct: SocialAccountRow, _cursor?: string): Promise<Page<ExternalMediaItem>> {
    if (!env.DEMO_MODE) throw badRequest('Demo mode is switched off on this server.');

    const identity = demoIdentity(acct.userId);
    const palette = paletteFor(identity.seedInt);
    const captions = dogCaptions(identity);
    const items: ExternalMediaItem[] = [];

    for (let i = 0; i < DOG_COUNT; i += 1) {
      items.push({
        externalId: `demo-${identity.seedHex}-${i}`,
        buffer: await renderJpeg(dogSvg(palette, i)),
        mimeType: 'image/jpeg',
        caption: captions[i] ?? `${identity.name} being a very good dog`,
        // Deterministic spacing, anchored to "now" so the feed looks recent.
        takenAt: new Date(Date.now() - (DOG_COUNT + NON_DOG_COUNT - i) * 4 * 86_400_000),
      });
    }

    const nonDog = [skylineSvg(identity.seedInt), foodSvg(identity.seedInt)];
    for (let i = 0; i < NON_DOG_COUNT; i += 1) {
      items.push({
        externalId: `demo-${identity.seedHex}-${DOG_COUNT + i}`,
        buffer: await renderJpeg(nonDog[i] ?? skylineSvg(identity.seedInt)),
        mimeType: 'image/jpeg',
        caption: NON_DOG_CAPTIONS[i] ?? null,
        takenAt: new Date(Date.now() - (NON_DOG_COUNT - i) * 4 * 86_400_000),
      });
    }

    // Everything fits in one page — no cursor.
    return { items, nextCursor: null };
  },

  async revoke(_acct: SocialAccountRow): Promise<void> {
    // Nothing external to revoke.
  },
};
