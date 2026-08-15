/**
 * Generates the PWA icon set (the paw mark on a cream tile) so the app can be
 * installed to an iPhone home screen. Run once; output is committed.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'apps/web/public/icons');
mkdirSync(outDir, { recursive: true });

const CREAM = '#FAF6F0';
const PRIMARY = '#C4623A';

/** @param {number} size @param {boolean} maskable */
function paw(size, maskable) {
  // Maskable icons must keep their content inside a safe circle (~80%).
  const s = maskable ? size * 0.62 : size * 0.78;
  const cx = size / 2;
  const cy = size / 2 + s * 0.06;
  const r = s / 2;

  const toes = [
    [cx - r * 0.62, cy - r * 0.62, r * 0.26, r * 0.34],
    [cx - r * 0.18, cy - r * 0.86, r * 0.24, r * 0.33],
    [cx + r * 0.28, cy - r * 0.82, r * 0.24, r * 0.33],
    [cx + r * 0.68, cy - r * 0.5, r * 0.24, r * 0.31],
  ]
    .map(([x, y, rx, ry]) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${PRIMARY}"/>`)
    .join('');

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" rx="${maskable ? 0 : size * 0.22}" fill="${CREAM}"/>
    ${toes}
    <path d="M ${cx} ${cy - r * 0.18}
             C ${cx - r * 0.78} ${cy - r * 0.18}, ${cx - r * 0.82} ${cy + r * 0.82}, ${cx - r * 0.18} ${cy + r * 0.84}
             C ${cx + r * 0.14} ${cy + r * 0.95}, ${cx + r * 0.82} ${cy + r * 0.7}, ${cx + r * 0.7} ${cy + r * 0.16}
             C ${cx + r * 0.62} ${cy - r * 0.2}, ${cx + r * 0.34} ${cy - r * 0.18}, ${cx} ${cy - r * 0.18} Z"
          fill="${PRIMARY}"/>
  </svg>`);
}

const targets = [
  { name: 'icon-180.png', size: 180, maskable: false },
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
];

for (const t of targets) {
  await sharp(paw(t.size, t.maskable)).png().toFile(path.join(outDir, t.name));
  console.log(`  ✓ ${t.name}`);
}
console.log(`\nIcons written to ${outDir}`);
