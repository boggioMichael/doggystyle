import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * Deterministic synthetic dog photos for demo/seed data.
 *
 * We generate stylised silhouettes rather than shipping real photographs: no
 * licensing questions, no real animals or people, tiny repo, and the output is
 * reproducible from a seed string. The shapes are deliberately warm-toned and
 * fill a good share of the frame so the media pipeline's heuristics treat them
 * the way they would treat a real pet photo.
 */

export interface Palette {
  fur: string;
  furShade: string;
  sky: string;
  ground: string;
  accent: string;
}

function seedInt(seed: string, salt: string): number {
  return Number.parseInt(createHash('sha256').update(`${seed}:${salt}`).digest('hex').slice(0, 8), 16);
}

export function paletteFor(seed: string): Palette {
  const hue = seedInt(seed, 'hue') % 60; // warm browns / creams / golds
  const light = 45 + (seedInt(seed, 'light') % 25);
  return {
    fur: `hsl(${20 + hue}, 55%, ${light}%)`,
    furShade: `hsl(${20 + hue}, 50%, ${Math.max(22, light - 16)}%)`,
    sky: `hsl(${190 + (seedInt(seed, 'sky') % 30)}, 45%, ${72 + (seedInt(seed, 'skyl') % 10)}%)`,
    ground: `hsl(${90 + (seedInt(seed, 'ground') % 40)}, 38%, ${48 + (seedInt(seed, 'gl') % 14)}%)`,
    accent: `hsl(${(seedInt(seed, 'accent') % 360)}, 60%, 55%)`,
  };
}

/** A stylised dog against an outdoor background. */
export function dogSvg(seed: string, variant: number): string {
  const p = paletteFor(seed);
  const tilt = ((seedInt(seed, `tilt${variant}`) % 14) - 7);
  const earDrop = 30 + (seedInt(seed, `ear${variant}`) % 40);
  const tailUp = (seedInt(seed, `tail${variant}`) % 2) === 0;
  const horizon = 360 + (variant % 3) * 18;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.sky}"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.55"/>
    </linearGradient>
    <radialGradient id="furg" cx="40%" cy="35%">
      <stop offset="0%" stop-color="${p.fur}"/>
      <stop offset="100%" stop-color="${p.furShade}"/>
    </radialGradient>
  </defs>

  <rect width="800" height="600" fill="url(#sky)"/>
  <ellipse cx="${140 + variant * 60}" cy="${110 + (variant % 3) * 20}" rx="70" ry="26" fill="#ffffff" opacity="0.7"/>
  <ellipse cx="${520 - variant * 40}" cy="${86 + (variant % 2) * 26}" rx="52" ry="20" fill="#ffffff" opacity="0.6"/>
  <rect y="${horizon}" width="800" height="${600 - horizon}" fill="${p.ground}"/>
  <ellipse cx="400" cy="${horizon + 10}" rx="360" ry="30" fill="${p.ground}"/>

  <g transform="translate(400 360) rotate(${tilt}) translate(-400 -360)">
    <!-- tail -->
    <path d="M256 372 Q ${tailUp ? '196 300 228 262' : '186 392 214 424'}"
          stroke="${p.furShade}" stroke-width="26" stroke-linecap="round" fill="none"/>
    <!-- legs -->
    <rect x="322" y="404" width="30" height="86" rx="15" fill="${p.furShade}"/>
    <rect x="386" y="410" width="30" height="80" rx="15" fill="${p.furShade}"/>
    <rect x="452" y="404" width="30" height="86" rx="15" fill="${p.furShade}"/>
    <!-- body -->
    <ellipse cx="392" cy="372" rx="150" ry="94" fill="url(#furg)"/>
    <!-- chest -->
    <ellipse cx="470" cy="392" rx="66" ry="72" fill="${p.fur}"/>
    <!-- head -->
    <circle cx="536" cy="286" r="82" fill="url(#furg)"/>
    <!-- ears -->
    <ellipse cx="486" cy="${232 + earDrop / 3}" rx="26" ry="${earDrop}" fill="${p.furShade}" transform="rotate(-18 486 250)"/>
    <ellipse cx="588" cy="${230 + earDrop / 3}" rx="26" ry="${earDrop}" fill="${p.furShade}" transform="rotate(16 588 250)"/>
    <!-- muzzle -->
    <ellipse cx="576" cy="322" rx="52" ry="38" fill="#F6E7D6"/>
    <ellipse cx="604" cy="310" rx="15" ry="12" fill="#2B2320"/>
    <!-- eyes -->
    <circle cx="512" cy="268" r="9" fill="#2B2320"/>
    <circle cx="566" cy="264" r="9" fill="#2B2320"/>
    <circle cx="514" cy="265" r="3" fill="#fff"/>
    <circle cx="568" cy="261" r="3" fill="#fff"/>
    <!-- collar -->
    <path d="M474 348 Q 536 384 596 344" stroke="${p.accent}" stroke-width="16" fill="none" stroke-linecap="round"/>
  </g>
</svg>`;
}

/** Obvious non-dog images, so the classifier stage has something to down-score. */
export function nonDogSvg(seed: string, variant: number): string {
  const hue = seedInt(seed, `nd${variant}`) % 360;
  if (variant % 2 === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
      <rect width="800" height="600" fill="hsl(${hue},18%,88%)"/>
      ${Array.from({ length: 7 }, (_, i) => {
        const h = 120 + ((seedInt(seed, `b${variant}${i}`) % 300));
        return `<rect x="${40 + i * 105}" y="${600 - h}" width="78" height="${h}" fill="hsl(${(hue + i * 12) % 360},14%,${34 + i * 3}%)"/>`;
      }).join('')}
    </svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
    <rect width="800" height="600" fill="hsl(${hue},30%,92%)"/>
    <circle cx="400" cy="300" r="190" fill="hsl(${(hue + 40) % 360},48%,62%)"/>
    <circle cx="400" cy="300" r="120" fill="hsl(${(hue + 90) % 360},52%,74%)"/>
    <rect x="180" y="470" width="440" height="26" rx="13" fill="hsl(${hue},22%,58%)"/>
  </svg>`;
}

export async function renderJpeg(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toBuffer();
}

export async function dogPhoto(seed: string, variant: number): Promise<Buffer> {
  return renderJpeg(dogSvg(seed, variant));
}

export async function nonDogPhoto(seed: string, variant: number): Promise<Buffer> {
  return renderJpeg(nonDogSvg(seed, variant));
}
