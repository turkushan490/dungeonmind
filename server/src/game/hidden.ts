import type { LogEntry } from '@dungeonmind/shared';
import type { GameRole, GameRow } from './store.js';

/** Keep comparisons readable, including resolveRoll and concentration-save text. */
export function redactTargets(text: string): string {
  return text
    .replace(/\s+vs\s+(?:AC|DC)\s+[+-]?\d+(?:\.\d+)?\b/gi, '')
    .replace(/\b(AC|DC)\s*[:=]?\s*[+-]?\d+(?:\.\d+)?\b/gi, '$1 ?');
}

export const hidesTargets = (g: GameRow, role: GameRole) => !!g.settings.hideTargets && role !== 'host';

/** Only client delivery uses these views; stored records and DM prompts stay complete. */
export const textFor = (g: GameRow, role: GameRole, text: string) => hidesTargets(g, role) ? redactTargets(text) : text;

export function logFor(g: GameRow, role: GameRole, entry: LogEntry): LogEntry {
  if (!hidesTargets(g, role)) return entry;
  const visible = { ...entry, text: redactTargets(entry.text) };
  if (entry.kind === 'roll') {
    const { dc, targetAc, margin, dcReason, ...data } = entry.data ?? {};
    visible.data = { ...data, hidden: true };
  }
  return visible;
}
