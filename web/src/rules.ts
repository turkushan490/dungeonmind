import { useEffect, useState } from 'react';
import type { RulesBackground, RulesClass, RulesSpecies, RulesSpell, Ruleset } from '@dungeonmind/shared';
import { api } from './api';

export interface BuilderData {
  ruleset: Ruleset;
  classes: RulesClass[];
  species: RulesSpecies[];
  backgrounds: RulesBackground[];
  skills: { id: string; name: string; ability: string }[];
  feats: { id: string; name: string }[];
}

const cache = new Map<string, Promise<any>>();
const cached = <T,>(url: string): Promise<T> => {
  if (!cache.has(url)) cache.set(url, api<T>(url).catch((e) => (cache.delete(url), Promise.reject(e))));
  return cache.get(url)!;
};

export function useBuilderData(ruleset: Ruleset): BuilderData | undefined {
  const [d, setD] = useState<BuilderData>();
  useEffect(() => {
    setD(undefined);
    cached<BuilderData>(`/api/rules/${ruleset}/builder`).then(setD);
  }, [ruleset]);
  return d;
}

export function useSpells(ruleset: Ruleset, cls?: string): RulesSpell[] {
  const [s, setS] = useState<RulesSpell[]>([]);
  useEffect(() => {
    if (!cls) return setS([]);
    cached<RulesSpell[]>(`/api/rules/${ruleset}/spells?class=${cls}`).then(setS);
  }, [ruleset, cls]);
  return s;
}

export const titleCase = (id: string) => id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
