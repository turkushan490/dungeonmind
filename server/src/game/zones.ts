import type { Zone } from '@dungeonmind/shared';
import { clip, sameName } from './text.js';

/**
 * Validates the State LLM's zone board: unique zone names, distances 0-5000 ft (made symmetric),
 * positions only for known creatures, each creature in one zone.
 */
export function cleanZones(rawZones: unknown, rawPositions: unknown, known: string[]): { zones: Zone[]; positions: Record<string, string[]> } {
  const zones: Zone[] = [];
  for (const z of Array.isArray(rawZones) ? rawZones.slice(0, 12) : []) {
    const name = typeof z?.name === 'string' ? clip(z.name.trim(), 40) : '';
    if (!name || zones.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    zones.push({ name, distances: {} });
  }
  // Distances, both ways.
  for (const z of Array.isArray(rawZones) ? rawZones : []) {
    const from = zones.find((x) => x.name.toLowerCase() === String(z?.name ?? '').trim().toLowerCase());
    if (!from || typeof z.distances !== 'object' || !z.distances) continue;
    for (const [k, v] of Object.entries(z.distances as Record<string, unknown>)) {
      const to = zones.find((x) => x.name.toLowerCase() === k.trim().toLowerCase());
      const ft = Math.round(Number(v));
      if (!to || to === from || !Number.isFinite(ft) || ft < 0 || ft > 5000) continue;
      from.distances[to.name] = ft;
      to.distances[from.name] ??= ft;
    }
  }
  const positions: Record<string, string[]> = {};
  const placed = new Set<string>();
  for (const [zoneName, who] of Object.entries(typeof rawPositions === 'object' && rawPositions ? (rawPositions as Record<string, unknown>) : {})) {
    let zone = zones.find((x) => x.name.toLowerCase() === zoneName.trim().toLowerCase());
    if (!zone && zones.length < 12 && zoneName.trim()) {
      zone = { name: clip(zoneName.trim(), 40), distances: {} };
      zones.push(zone);
    }
    if (!zone) continue;
    for (const w of Array.isArray(who) ? who : []) {
      const name = known.find((k) => sameName(k, String(w)));
      if (!name || placed.has(name)) continue;
      placed.add(name);
      (positions[zone.name] ??= []).push(name);
    }
  }
  return { zones, positions };
}

export function zoneOf(positions: Record<string, string[]>, name: string): string | undefined {
  return Object.entries(positions).find(([, list]) => list.some((n) => sameName(n, name)))?.[0];
}

/** Feet between two creatures: 5 in the same zone (melee reach), else the zone distance (undefined if unknown). */
export function range(zones: Zone[], positions: Record<string, string[]>, a: string, b: string): number | undefined {
  const za = zoneOf(positions, a);
  const zb = zoneOf(positions, b);
  if (!za || !zb) return;
  if (za === zb) return 5;
  return zones.find((z) => z.name === za)?.distances[zb] ?? zones.find((z) => z.name === zb)?.distances[za];
}
