/**
 * Location handling. The single most safety-critical module in the product.
 *
 * Rules enforced here:
 *  - Coordinates stored for matching are snapped to a coarse grid (~1.1 km).
 *  - Distances shown to users are bucketed, so repeated queries cannot be used
 *    to triangulate a home address.
 *  - Exact coordinates never pass through any function that produces a DTO.
 */

const EARTH_RADIUS_KM = 6371.0088;
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface LatLng {
  lat: number;
  lng: number;
}

export function isValidLatLng(p: Partial<LatLng> | null | undefined): p is LatLng {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Snap a precise coordinate to a ~1.1 km grid (0.01°). This is what gets stored
 * for matching — precise coordinates are only stored when the owner explicitly
 * opts in, and are used solely to compute a meetup midpoint.
 */
export function coarsenLatLng(p: LatLng, gridDegrees = 0.01): LatLng {
  const snap = (v: number) => Math.round(v / gridDegrees) * gridDegrees;
  return { lat: Number(snap(p.lat).toFixed(6)), lng: Number(snap(p.lng).toFixed(6)) };
}

/** Geohash encoder. 5 characters ≈ 4.9 km × 4.9 km — deliberately coarse. */
export function geohash(p: LatLng, precision = 5): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = '';
  let bits = 0;
  let bitCount = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (p.lng > mid) {
        bits = (bits << 1) | 1;
        lngMin = mid;
      } else {
        bits = bits << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (p.lat > mid) {
        bits = (bits << 1) | 1;
        latMin = mid;
      } else {
        bits = bits << 1;
        latMax = mid;
      }
    }
    even = !even;
    bitCount += 1;
    if (bitCount === 5) {
      hash += BASE32[bits] ?? '0';
      bits = 0;
      bitCount = 0;
    }
  }
  return hash;
}

/**
 * Bucket a distance for display. Deliberately lossy: an attacker repeating
 * searches from moving positions still cannot trilaterate a precise point.
 */
export function bucketDistanceKm(km: number): number {
  if (km < 1) return 0.5;
  if (km <= 10) return Math.round(km * 2) / 2; // 0.5 km buckets
  if (km <= 50) return Math.round(km); // 1 km buckets
  return Math.round(km / 10) * 10; // 10 km buckets
}

export function distanceLabel(km: number | null | undefined): string {
  if (km === null || km === undefined || !Number.isFinite(km)) return 'Distance unknown';
  if (km < 1) return 'Under 1 km away';
  const bucketed = bucketDistanceKm(km);
  if (bucketed > 50) return 'Over 50 km away';
  const rendered = bucketed % 1 === 0 ? String(bucketed) : bucketed.toFixed(1);
  return `~${rendered} km away`;
}

/**
 * Bounding box for a radius query. Used as a cheap SQL pre-filter before the
 * exact haversine calculation.
 */
export function boundingBox(centre: LatLng, radiusKm: number): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const latDelta = radiusKm / 111.32;
  const cosLat = Math.max(0.01, Math.cos(toRad(centre.lat)));
  const lngDelta = radiusKm / (111.32 * cosLat);
  return {
    minLat: Math.max(-90, centre.lat - latDelta),
    maxLat: Math.min(90, centre.lat + latDelta),
    minLng: Math.max(-180, centre.lng - lngDelta),
    maxLng: Math.min(180, centre.lng + lngDelta),
  };
}

/** Geographic midpoint — used to suggest a meetup area roughly halfway. */
export function midpoint(a: LatLng, b: LatLng): LatLng {
  const lat1 = toRad(a.lat);
  const lng1 = toRad(a.lng);
  const lat2 = toRad(b.lat);
  const lng2 = toRad(b.lng);
  const bx = Math.cos(lat2) * Math.cos(lng2 - lng1);
  const by = Math.cos(lat2) * Math.sin(lng2 - lng1);
  const lat3 = Math.atan2(Math.sin(lat1) + Math.sin(lat2), Math.sqrt((Math.cos(lat1) + bx) ** 2 + by ** 2));
  const lng3 = lng1 + Math.atan2(by, Math.cos(lat1) + bx);
  return {
    lat: Number(((lat3 * 180) / Math.PI).toFixed(6)),
    lng: Number((((((lng3 * 180) / Math.PI + 540) % 360) - 180)).toFixed(6)),
  };
}

/** A small set of well-known cities so demo/seed data has believable geography. */
export const KNOWN_CITIES: ReadonlyArray<{ city: string; country: string; lat: number; lng: number; aliases?: string[] }> = [
  { city: 'Tel Aviv', country: 'IL', lat: 32.0853, lng: 34.7818, aliases: ['tel aviv-yafo', 'tlv'] },
  { city: 'Ramat Gan', country: 'IL', lat: 32.07, lng: 34.8248 },
  { city: 'Givatayim', country: 'IL', lat: 32.0722, lng: 34.8117 },
  { city: 'Herzliya', country: 'IL', lat: 32.1624, lng: 34.8447 },
  { city: 'Ra’anana', country: 'IL', lat: 32.1848, lng: 34.8713, aliases: ['raanana', "ra'anana"] },
  { city: 'Petah Tikva', country: 'IL', lat: 32.084, lng: 34.8878, aliases: ['petach tikva'] },
  { city: 'Rishon LeZion', country: 'IL', lat: 31.9730, lng: 34.7925, aliases: ['rishon lezion', 'rishon'] },
  { city: 'Jerusalem', country: 'IL', lat: 31.7683, lng: 35.2137 },
  { city: 'Haifa', country: 'IL', lat: 32.7940, lng: 34.9896 },
  { city: 'Netanya', country: 'IL', lat: 32.3215, lng: 34.8532 },
  { city: 'Be’er Sheva', country: 'IL', lat: 31.2530, lng: 34.7915, aliases: ['beer sheva', 'beersheba'] },
  { city: 'Eilat', country: 'IL', lat: 29.5577, lng: 34.9519 },
  { city: 'London', country: 'GB', lat: 51.5072, lng: -0.1276 },
  { city: 'Berlin', country: 'DE', lat: 52.52, lng: 13.405 },
  { city: 'Amsterdam', country: 'NL', lat: 52.3676, lng: 4.9041 },
  { city: 'Paris', country: 'FR', lat: 48.8566, lng: 2.3522 },
  { city: 'New York', country: 'US', lat: 40.7128, lng: -74.006, aliases: ['nyc'] },
  { city: 'San Francisco', country: 'US', lat: 37.7749, lng: -122.4194, aliases: ['sf'] },
  { city: 'Austin', country: 'US', lat: 30.2672, lng: -97.7431 },
  { city: 'Toronto', country: 'CA', lat: 43.6532, lng: -79.3832 },
  { city: 'Sydney', country: 'AU', lat: -33.8688, lng: 151.2093 },
];

export function lookupCity(input: string): (typeof KNOWN_CITIES)[number] | undefined {
  const needle = input.trim().toLowerCase();
  if (!needle) return undefined;
  return KNOWN_CITIES.find(
    (c) => c.city.toLowerCase() === needle || (c.aliases ?? []).some((a) => a.toLowerCase() === needle),
  );
}

export function formatCoarseLabel(city: string | null, country: string | null): string | null {
  if (city && country) return `${city}, ${country}`;
  return city ?? country ?? null;
}
