import type { GameCharacter, GameSettings, Npc } from '@dungeonmind/shared';
import { RULESET_NAMES } from '@dungeonmind/shared';
import { db } from '../db.js';
import { titleCase } from './text.js';

/** The fixed sections of every campaign.md, in order. */
export const SECTIONS = [
  'How to run',
  'Story so far',
  'Current scene',
  'Party status',
  'NPCs',
  'Locations',
  'Quests and open threads',
  'Loot and items',
  'Rulings made',
  'Timeline',
] as const;
export type Section = (typeof SECTIONS)[number];

/** The party table is generated from the database, never written by the AI. */
const DB_SECTIONS: Section[] = ['Party status'];

export function parseSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | undefined;
  for (const line of md.split('\n')) {
    const h = /^## (?:\d+\.\s*)?(.+?)\s*$/.exec(line);
    if (h && SECTIONS.includes(h[1] as Section)) {
      current = h[1];
      out[current] = '';
      continue;
    }
    if (current) out[current] += (out[current] ? '\n' : '') + line;
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

export function renderCampaign(title: string, sections: Record<string, string>): string {
  return `# ${title}\n\n${SECTIONS.map((s, i) => `## ${i + 1}. ${s}\n${(sections[s] ?? '').trim() || '_(nothing yet)_'}`).join('\n\n')}\n`;
}

export function partyTable(chars: GameCharacter[], npcs: Npc[] = []): string {
  const rows = chars.map(
    (c) =>
      `| ${c.name} | ${titleCase(c.species)} ${titleCase(c.class)} ${c.level} | ${c.hp}/${c.maxHp}${c.tempHp ? ` +${c.tempHp}` : ''} | ${c.counters
        .filter((k) => !k.name.startsWith('Hit Dice'))
        .map((k) => `${k.name} ${k.current}/${k.max}`)
        .join(', ') || '-'} | ${[...c.conditions.map((x) => x.name), ...(c.concentration ? [`concentrating: ${c.concentration}`] : [])].join(', ') || '-'} | ${c.xp} | ${c.absent ? 'away' : c.seated ? 'playing' : 'resting'} |`,
  );
  const foes = npcs.filter((n) => n.status !== 'dead' && n.status !== 'fled');
  return [
    '| Character | Class | HP | Resources | Conditions | XP | Status |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    ...(foes.length ? ['', '**NPCs present:** ' + foes.map((n) => `${n.name}${n.hp !== undefined ? ` (${n.hp}/${n.maxHp ?? '?'} HP${n.ac ? `, AC ${n.ac}` : ''})` : ''}${n.status ? ` ${n.status}` : ''}`).join('; ')] : []),
  ].join('\n');
}

/** A fresh campaign file from the setup (pitch, form answers, house rules). */
export function initialCampaign(name: string, ruleset: keyof typeof RULESET_NAMES, s: GameSettings, chars: GameCharacter[]): string {
  const answers = Object.entries(s.formValues ?? {})
    .map(([k, v]) => `- ${s.form?.fields.find((f) => f.id === k)?.label ?? k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');
  return renderCampaign(name, {
    'How to run': [
      `- Ruleset: ${RULESET_NAMES[ruleset]}. Levels ${s.startLevel} to ${s.endLevel}. Advancement: ${s.xpMode === 'xp' ? 'XP' : 'milestones'}.`,
      '- Tone: dark, mature, grounded. Players write in English (typos are fine).',
      '- The server owns every number (dice, HP, slots, features, XP). Never invent results.',
      s.houseRules ? `- House rules: ${s.houseRules}` : '',
      s.pitch ? `\n**Pitch: ${s.pitch.title}.** ${s.pitch.hook}` : '',
      s.form?.summary ? `\n${s.form.summary}` : '',
      answers ? `\n**Setup answers**\n${answers}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    'Story so far': s.pitch ? `The adventure begins. ${s.pitch.hook}` : 'The adventure begins.',
    'Party status': partyTable(chars),
  });
}

export interface Patch {
  section: string;
  op: 'replace' | 'append';
  text: string;
}

/** Applies the Chronicler's patches; unknown sections and the party table are ignored. */
export function applyPatches(md: string, patches: Patch[]): { md: string; applied: number } {
  const title = /^# (.+)$/m.exec(md)?.[1] ?? 'Campaign';
  const sec = parseSections(md);
  let applied = 0;
  for (const p of patches ?? []) {
    const name = SECTIONS.find((s) => s.toLowerCase() === String(p?.section ?? '').toLowerCase().replace(/^\d+\.\s*/, ''));
    if (!name || DB_SECTIONS.includes(name) || typeof p.text !== 'string' || !p.text.trim()) continue;
    const text = p.text.trim().slice(0, 8000);
    const before = sec[name] && sec[name] !== '_(nothing yet)_' ? sec[name] : '';
    sec[name] = p.op === 'replace' ? text : before ? `${before}\n${text}` : text;
    applied++;
  }
  return { md: renderCampaign(title, sec), applied };
}

/** Refreshes the generated party table inside the file. */
export function withParty(md: string, chars: GameCharacter[], npcs: Npc[]): string {
  const title = /^# (.+)$/m.exec(md)?.[1] ?? 'Campaign';
  const sec = parseSections(md);
  sec['Party status'] = partyTable(chars, npcs);
  return renderCampaign(title, sec);
}

export function currentCampaign(gameId: string): string {
  return (db.prepare('SELECT md FROM campaign_versions WHERE game_id = ? ORDER BY id DESC LIMIT 1').get(gameId) as { md: string } | undefined)?.md ?? '';
}

/** Every version is kept; saving the same text again is a no-op. */
export function saveCampaign(gameId: string, md: string, author: 'chronicler' | 'host' | 'system', turn: number): boolean {
  if (currentCampaign(gameId) === md) return false;
  db.prepare('INSERT INTO campaign_versions (game_id, md, author, turn) VALUES (?, ?, ?, ?)').run(gameId, md, author, turn);
  return true;
}
