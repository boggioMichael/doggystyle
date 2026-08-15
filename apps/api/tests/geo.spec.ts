import { describe, expect, it } from 'vitest';
import {
  boundingBox,
  bucketDistanceKm,
  coarsenLatLng,
  distanceLabel,
  geohash,
  haversineKm,
  lookupCity,
  midpoint,
} from '../src/lib/geo.js';

const TLV = { lat: 32.0853, lng: 34.7818 };
const HAIFA = { lat: 32.794, lng: 34.9896 };

describe('geo — the privacy-critical maths', () => {
  it('measures real distances', () => {
    // Tel Aviv to Haifa is roughly 80 km.
    expect(haversineKm(TLV, HAIFA)).toBeGreaterThan(75);
    expect(haversineKm(TLV, HAIFA)).toBeLessThan(90);
    expect(haversineKm(TLV, TLV)).toBeCloseTo(0, 6);
  });

  it('buckets distances so repeated queries cannot trilaterate a home', () => {
    expect(bucketDistanceKm(0.3)).toBe(0.5);
    expect(bucketDistanceKm(4.26)).toBe(4.5);
    expect(bucketDistanceKm(23.4)).toBe(23);
    expect(bucketDistanceKm(61)).toBe(60);
  });

  it('never renders a precise distance in a label', () => {
    expect(distanceLabel(0.42)).toBe('Under 1 km away');
    expect(distanceLabel(4.2618374)).toBe('~4.5 km away');
    expect(distanceLabel(120)).toBe('Over 50 km away');
    expect(distanceLabel(null)).toBe('Distance unknown');
    // No label may leak sub-100m precision.
    for (const km of [1.234567, 7.891011, 33.33333]) {
      expect(distanceLabel(km)).not.toMatch(/\d\.\d{2,}/);
    }
  });

  it('snaps nearby points onto the same coarse grid cell', () => {
    const a = coarsenLatLng({ lat: 32.08531, lng: 34.78182 });
    const b = coarsenLatLng({ lat: 32.08689, lng: 34.78399 });
    expect(a).toEqual(b);
  });

  it('emits a 5-character geohash and nothing finer', () => {
    const hash = geohash(TLV);
    expect(hash).toHaveLength(5);
    expect(geohash(TLV)).toBe(hash);
    // Two points ~200m apart share a cell at this precision.
    expect(geohash({ lat: 32.0861, lng: 34.7825 })).toBe(hash);
  });

  it('puts the midpoint between two cities', () => {
    const mid = midpoint(TLV, HAIFA);
    expect(mid.lat).toBeGreaterThan(TLV.lat);
    expect(mid.lat).toBeLessThan(HAIFA.lat);
  });

  it('produces a bounding box that contains everything inside the radius', () => {
    const box = boundingBox(TLV, 10);
    const inside = { lat: TLV.lat + 0.05, lng: TLV.lng + 0.05 };
    expect(haversineKm(TLV, inside)).toBeLessThan(10);
    expect(inside.lat).toBeGreaterThanOrEqual(box.minLat);
    expect(inside.lat).toBeLessThanOrEqual(box.maxLat);
    expect(inside.lng).toBeGreaterThanOrEqual(box.minLng);
    expect(inside.lng).toBeLessThanOrEqual(box.maxLng);
  });

  it('looks cities up by name and alias', () => {
    expect(lookupCity('Tel Aviv')?.country).toBe('IL');
    expect(lookupCity('tlv')?.city).toBe('Tel Aviv');
    expect(lookupCity('Atlantis')).toBeUndefined();
  });
});
