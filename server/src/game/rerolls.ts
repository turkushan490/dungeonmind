import type { GameCharacter } from '@dungeonmind/shared';

/** Who votes on a reroll: every player with an active character (one vote per player). */
export const voters = (chars: GameCharacter[]) => [...new Set(chars.filter((c) => c.seated && !c.absent).map((c) => c.userId))];

/**
 * Majority vote: passes when more than half of the voters said yes; fails as soon as a majority
 * can no longer be reached; otherwise still open.
 */
export function tally(votes: Record<string, boolean>, voterIds: string[]): 'pass' | 'fail' | 'open' {
  const yes = voterIds.filter((v) => votes[v] === true).length;
  const no = voterIds.filter((v) => votes[v] === false).length;
  const need = Math.floor(voterIds.length / 2) + 1;
  if (yes >= need) return 'pass';
  if (voterIds.length - no < need) return 'fail';
  return 'open';
}
