import type { GameCharacter, GameDetail, LogEntry } from '@dungeonmind/shared';
import type { ComponentType } from 'react';

/**
 * Slots later features fill in (dice tray + zone board, voices, animations) without the table
 * having to know them. Each is optional.
 */
export const tableExtras: {
  board?: ComponentType<{ g: GameDetail }>;
  sheet?: ComponentType<{ g: GameDetail; c: GameCharacter }>;
  narration?: ComponentType<{ g: GameDetail; e: LogEntry; last: boolean }>;
  top?: ComponentType<{ g: GameDetail }>;
} = {};
