import sharp from 'sharp';
import type { MediaFeatures } from '../types.js';

/**
 * Local image understanding. Pixels NEVER leave the machine — even when the
 * Anthropic provider is enabled, image analysis stays here (ADR 0007).
 *
 * This is a statistical estimator, not a trained classifier: it produces a
 * calibrated-ish "looks like a pet photo" score plus a colour/texture signature
 * used to group photos of the same dog. The product treats the result as a
 * *suggestion* that the owner confirms — never as ground truth.
 */

const GRID = 48; // analysis resolution
const HUE_BINS = 12;
const SAT_BINS = 3;
const VAL_BINS = 3;

export async function analyseImageHeuristic(buffer: Buffer): Promise<MediaFeatures> {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(GRID, GRID, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const px = (x: number, y: number): [number, number, number] => {
    const i = (y * w + x) * 3;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
  };

  const histogram = new Array<number>(HUE_BINS * SAT_BINS * VAL_BINS).fill(0);
  let brightnessSum = 0;
  let saturationSum = 0;
  let greenBlueSum = 0;
  let furHueSum = 0;
  let n = 0;

  const luma: number[] = new Array(w * h).fill(0);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = px(x, y);
      const { hue, sat, val } = rgbToHsv(r, g, b);

      brightnessSum += val;
      saturationSum += sat;
      luma[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;

      // Vegetation / sky signal → outdoor
      if ((hue >= 70 && hue <= 160 && sat > 0.18) || (hue >= 180 && hue <= 250 && sat > 0.15)) {
        greenBlueSum += 1;
      }
      // Fur-ish: warm browns/creams/greys, low-to-moderate saturation
      if ((hue >= 15 && hue <= 55 && sat >= 0.08 && sat <= 0.75) || (sat < 0.12 && val > 0.12 && val < 0.95)) {
        furHueSum += 1;
      }

      const hb = Math.min(HUE_BINS - 1, Math.floor((hue / 360) * HUE_BINS));
      const sb = Math.min(SAT_BINS - 1, Math.floor(sat * SAT_BINS));
      const vb = Math.min(VAL_BINS - 1, Math.floor(val * VAL_BINS));
      histogram[hb * SAT_BINS * VAL_BINS + sb * VAL_BINS + vb] += 1;
      n += 1;
    }
  }

  const brightness = brightnessSum / n;
  const saturation = saturationSum / n;
  const outdoorRatio = greenBlueSum / n;
  const furRatio = furHueSum / n;

  /* ── Sharpness: mean absolute Laplacian over the luma plane ─────────────── */
  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const c = luma[y * w + x] ?? 0;
      const lap =
        4 * c -
        (luma[(y - 1) * w + x] ?? 0) -
        (luma[(y + 1) * w + x] ?? 0) -
        (luma[y * w + (x - 1)] ?? 0) -
        (luma[y * w + (x + 1)] ?? 0);
      edgeSum += Math.abs(lap);
      edgeCount += 1;
    }
  }
  const sharpness = clamp01(edgeSum / edgeCount / 60);

  /* ── Subject fill: how much of the frame differs from the border colour ─── */
  const border = averageBorderColour(px, w, h);
  let subjectPixels = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = px(x, y);
      const dist = Math.abs(r - border[0]) + Math.abs(g - border[1]) + Math.abs(b - border[2]);
      // Weight the centre — the subject of a pet photo is usually centred.
      const cx = (x - w / 2) / (w / 2);
      const cy = (y - h / 2) / (h / 2);
      const centreWeight = 1 - Math.min(1, Math.sqrt(cx * cx + cy * cy) / 1.4);
      if (dist > 90) subjectPixels += 0.4 + 0.6 * centreWeight;
    }
  }
  const subjectFill = clamp01(subjectPixels / (w * h));

  /* ── Composite "is this a pet photo" estimate ───────────────────────────── */
  const exposureOk = 1 - Math.min(1, Math.abs(brightness - 0.5) * 2.2);
  const dogScore = clamp01(
    0.34 * furRatio * 1.6 +
      0.22 * subjectFill * 1.5 +
      0.16 * sharpness +
      0.14 * outdoorRatio * 1.4 +
      0.14 * exposureOk,
  );

  const qualityScore = clamp01(
    0.42 * sharpness + 0.28 * exposureOk + 0.18 * clamp01(subjectFill * 1.8) + 0.12 * clamp01(saturation * 1.5),
  );

  // L1-normalise the histogram so signature distance is scale-invariant.
  const signature = histogram.map((v) => Number((v / n).toFixed(5)));

  return {
    dogScore: round3(dogScore),
    qualityScore: round3(qualityScore),
    signature,
    brightness: round3(brightness),
    saturation: round3(saturation),
    sharpness: round3(sharpness),
    subjectFill: round3(subjectFill),
    outdoor: outdoorRatio > 0.22,
  };
}

/* ── Clustering support ───────────────────────────────────────────────────── */

/** Chi-square distance between two normalised histograms → 0 (same) … 1 (different). */
export function signatureDistance(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    const denom = ai + bi;
    if (denom > 0) sum += ((ai - bi) * (ai - bi)) / denom;
  }
  return clamp01(sum / 2);
}

/**
 * Greedy agglomerative clustering over visual signatures.
 *
 * Used to separate "this owner has two dogs" and — importantly — to let the
 * owner say which cluster is actually *their* dog, because photos in someone's
 * feed often include dogs that are not theirs.
 */
export function clusterSignatures(
  items: Array<{ id: string; signature: number[] }>,
  threshold = 0.34,
): Map<string, string> {
  const assignment = new Map<string, string>();
  const centroids: Array<{ id: string; signature: number[]; count: number }> = [];

  for (const item of items) {
    let best: { id: string; distance: number } | null = null;
    for (const centroid of centroids) {
      const d = signatureDistance(item.signature, centroid.signature);
      if (!best || d < best.distance) best = { id: centroid.id, distance: d };
    }

    if (best && best.distance <= threshold) {
      assignment.set(item.id, best.id);
      const centroid = centroids.find((c) => c.id === best!.id)!;
      // Running mean keeps the centroid representative as the cluster grows.
      centroid.signature = centroid.signature.map(
        (v, i) => (v * centroid.count + (item.signature[i] ?? 0)) / (centroid.count + 1),
      );
      centroid.count += 1;
    } else {
      const clusterId = `c${centroids.length + 1}`;
      centroids.push({ id: clusterId, signature: [...item.signature], count: 1 });
      assignment.set(item.id, clusterId);
    }
  }

  return assignment;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function averageBorderColour(
  px: (x: number, y: number) => [number, number, number],
  w: number,
  h: number,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const add = (x: number, y: number) => {
    const [pr, pg, pb] = px(x, y);
    r += pr;
    g += pg;
    b += pb;
    n += 1;
  };
  for (let x = 0; x < w; x += 1) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 1; y < h - 1; y += 1) {
    add(0, y);
    add(w - 1, y);
  }
  return [r / n, g / n, b / n];
}

function rgbToHsv(r: number, g: number, b: number): { hue: number; sat: number; val: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let hue = 0;
  if (delta > 1e-6) {
    if (max === rn) hue = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) hue = 60 * ((bn - rn) / delta + 2);
    else hue = 60 * ((rn - gn) / delta + 4);
  }
  if (hue < 0) hue += 360;

  return { hue, sat: max === 0 ? 0 : delta / max, val: max };
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const round3 = (v: number): number => Number(v.toFixed(3));
