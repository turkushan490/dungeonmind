import { useEffect, useMemo, useState } from 'react';
import { ABILITIES, RULESET_NAMES, type Abilities, type Ability, type Character, type CharacterBuild, type Derived, type Ruleset } from '@dungeonmind/shared';
import { api } from '../api';
import { Sheet } from '../components/Sheet';
import { navigate } from '../router';
import { titleCase, useBuilderData, useSpells } from '../rules';

const STANDARD = [15, 14, 13, 12, 10, 8];
const COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

export const emptyBuild = (ruleset: Ruleset = 'srd51', level = 1): CharacterBuild => ({
  ruleset,
  name: '',
  species: '',
  class: '',
  background: '',
  level,
  abilityMethod: 'standard',
  baseAbilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
  skills: [],
  cantrips: [],
  spells: [],
  equipment: [],
});

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-3">
      <h2 className="rune-title flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-indigo-500 text-xs">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The step-by-step builder. Also opens AI-made and imported sheets as drafts, and edits existing characters.
 * Every change is checked by the server (POST /api/characters/validate), which also previews the sheet.
 */
export function Builder({ initial, characterId, lockRuleset, minLevel, maxLevel, onSaved }: {
  initial: CharacterBuild;
  characterId?: string;
  lockRuleset?: boolean;
  minLevel?: number;
  maxLevel?: number;
  onSaved?: (c: Character) => void;
}) {
  const [b, setB] = useState<CharacterBuild>(initial);
  const [check, setCheck] = useState<{ errors: string[]; character?: Character; derived?: Derived }>({ errors: [] });
  const [rolled, setRolled] = useState<number[]>();
  const [saving, setSaving] = useState(false);
  const data = useBuilderData(b.ruleset);
  const spells = useSpells(b.ruleset, b.class || undefined);
  const set = (patch: Partial<CharacterBuild>) => setB((x) => ({ ...x, ...patch }));

  const cls = data?.classes.find((c) => c.id === b.class);
  const sp = data?.species.find((s) => s.id === b.species);
  const bg = data?.backgrounds.find((x) => x.id === b.background);
  const lv = cls?.levels.find((l) => l.level === b.level)?.spellcasting;
  const maxSlot = lv ? lv.slots.reduce((m, n, i) => (n > 0 ? i + 1 : m), 0) : 0;

  // Debounced server check.
  useEffect(() => {
    const t = setTimeout(() => {
      api('/api/characters/validate', { body: b, quiet: true }).then(setCheck).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [b]);

  const points = useMemo(() => ABILITIES.reduce((s, a) => s + (COST[b.baseAbilities[a]] ?? 99), 0), [b.baseAbilities]);
  const setScore = (a: Ability, v: number) => set({ baseAbilities: { ...b.baseAbilities, [a]: v } });
  const fixedSkills = new Set(bg?.skills ?? []);

  const save = async () => {
    setSaving(true);
    try {
      const c = await api<Character>(characterId ? `/api/characters/${characterId}` : '/api/characters', { method: characterId ? 'PUT' : 'POST', body: b });
      onSaved ? onSaved(c) : navigate(`/characters/${c.id}`);
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <p className="text-slate-400">Loading the rules…</p>;
  const chosen = new Set(b.skills);
  const toggle = (list: string[], id: string, max: number) => (list.includes(id) ? list.filter((x) => x !== id) : list.length < max ? [...list, id] : list);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <Step n={1} title="Basics">
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              <span className="label">Ruleset</span>
              <select className="input" value={b.ruleset} disabled={lockRuleset || !!characterId} onChange={(e) => setB(emptyBuild(e.target.value as Ruleset, b.level))}>
                {Object.entries(RULESET_NAMES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Name</span>
              <input className="input" value={b.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label>
              <span className="label">Level</span>
              <input className="input" type="number" min={minLevel ?? 1} max={maxLevel ?? 20} value={b.level} onChange={(e) => set({ level: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
            </label>
          </div>
        </Step>

        <Step n={2} title="Species">
          <div className="grid gap-3 sm:grid-cols-2">
            <select className="input" value={b.species} onChange={(e) => set({ species: e.target.value, subspecies: undefined, bonusChoices: b.ruleset === 'srd52' ? b.bonusChoices : undefined })}>
              <option value="">– species –</option>
              {data.species.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {sp && sp.subspecies.length > 0 && (
              <select className="input" value={b.subspecies ?? ''} onChange={(e) => set({ subspecies: e.target.value || undefined })}>
                <option value="">– {b.ruleset === 'srd51' ? 'subrace' : 'lineage / ancestry'} –</option>
                {sp.subspecies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {sp && (
            <p className="text-xs text-slate-400">
              Speed {sp.speed} ft · {sp.size} · {sp.traits.join(', ')}
              {Object.keys(sp.abilityBonuses).length > 0 && ` · ${Object.entries(sp.abilityBonuses).map(([a, v]) => `${a.toUpperCase()} +${v}`).join(', ')}`}
            </p>
          )}
          {b.ruleset === 'srd51' && b.species === 'half-elf' && (
            <BonusPicker label="Half-elf: +1 to two abilities (not CHA)" options={ABILITIES.filter((a) => a !== 'cha')} value={b.bonusChoices ?? {}} pattern={[1, 1]} onChange={(v) => set({ bonusChoices: v })} />
          )}
        </Step>

        <Step n={3} title="Class">
          <div className="grid gap-3 sm:grid-cols-2">
            <select className="input" value={b.class} onChange={(e) => set({ class: e.target.value, subclass: undefined, skills: [], cantrips: [], spells: [] })}>
              <option value="">– class –</option>
              {data.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (d{c.hitDie})
                </option>
              ))}
            </select>
            {cls && cls.subclasses.length > 0 && (
              <select className="input" value={b.subclass ?? ''} onChange={(e) => set({ subclass: e.target.value || undefined })}>
                <option value="">– subclass –</option>
                {cls.subclasses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {cls && (
            <p className="text-xs text-slate-400">
              Saves {cls.saves.join(', ').toUpperCase()} · {cls.proficiencies.slice(0, 6).join(', ')}
              {cls.spellAbility && ` · casts with ${cls.spellAbility.toUpperCase()}`}
            </p>
          )}
          {cls && <p className="text-xs text-slate-500">Level {b.level}: {cls.levels.filter((l) => l.level <= b.level).flatMap((l) => l.features).join(', ')}</p>}
        </Step>

        <Step n={4} title="Background">
          <select className="input" value={b.background} onChange={(e) => set({ background: e.target.value, bonusChoices: b.ruleset === 'srd52' ? {} : b.bonusChoices })}>
            <option value="">– background –</option>
            {data.backgrounds.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          {bg && (
            <p className="text-xs text-slate-400">
              Skills: {bg.skills.map(titleCase).join(', ')}
              {bg.feat && ` · Feat: ${bg.feat}`}
            </p>
          )}
          {b.ruleset === 'srd52' && bg?.abilityOptions && (
            <BonusPicker label="Ability bonuses: +2/+1 or +1/+1/+1" options={bg.abilityOptions} value={b.bonusChoices ?? {}} pattern="2024" onChange={(v) => set({ bonusChoices: v })} />
          )}
        </Step>

        <Step n={5} title="Ability scores">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['standard', 'Standard array'],
                ['pointbuy', 'Point buy (27)'],
                ['rolled', '4d6 drop lowest (server roll)'],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                className={b.abilityMethod === m ? 'btn' : 'btn-ghost'}
                onClick={() =>
                  set({
                    abilityMethod: m,
                    rollId: undefined,
                    baseAbilities: m === 'pointbuy' ? { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 } : { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
          {b.abilityMethod === 'rolled' && (
            <div className="flex items-center gap-2">
              <button
                className="btn-ghost"
                onClick={async () => {
                  const r = await api<{ rollId: string; values: number[] }>('/api/characters/roll-abilities', { method: 'POST' });
                  setRolled(r.values);
                  const sorted = [...r.values].sort((x, y) => y - x);
                  set({ rollId: r.rollId, baseAbilities: Object.fromEntries(ABILITIES.map((a, i) => [a, sorted[i]])) as Abilities });
                }}
              >
                🎲 Roll six scores
              </button>
              {rolled && <span className="font-mono text-sm">{rolled.join(' · ')}</span>}
              <span className="text-xs text-slate-500">Swap them around below. Each roll is final.</span>
            </div>
          )}
          {b.abilityMethod === 'pointbuy' && <p className={`text-sm ${points > 27 ? 'text-red-400' : 'text-slate-400'}`}>{27 - points} points left</p>}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {ABILITIES.map((a) => (
              <label key={a} className="text-center">
                <span className="label">{a}</span>
                {b.abilityMethod === 'pointbuy' ? (
                  <div className="flex items-center justify-center gap-1">
                    <button className="btn-ghost px-2 py-0.5" onClick={() => setScore(a, Math.max(8, b.baseAbilities[a] - 1))}>
                      −
                    </button>
                    <span className="w-6 font-mono">{b.baseAbilities[a]}</span>
                    <button className="btn-ghost px-2 py-0.5" onClick={() => setScore(a, Math.min(15, b.baseAbilities[a] + 1))}>
                      +
                    </button>
                  </div>
                ) : (
                  <select className="input px-1 text-center" value={b.baseAbilities[a]} onChange={(e) => {
                    // Swap: picking a value another ability has trades the two.
                    const v = Number(e.target.value);
                    const other = ABILITIES.find((o) => o !== a && b.baseAbilities[o] === v);
                    set({ baseAbilities: { ...b.baseAbilities, [a]: v, ...(other ? { [other]: b.baseAbilities[a] } : {}) } });
                  }}>
                    {[...new Set(b.abilityMethod === 'rolled' && rolled ? rolled : b.abilityMethod === 'rolled' ? Object.values(b.baseAbilities) : STANDARD)].sort((x, y) => y - x).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                )}
                {check.character && <span className="text-xs text-slate-500">→ {check.character.abilities[a]}</span>}
              </label>
            ))}
          </div>
          {cls && b.level >= 4 && <AsiPicker build={b} onChange={(asi) => set({ asi })} />}
        </Step>

        {cls && (
          <Step n={6} title={`Skills (choose ${cls.skillChoices.choose})`}>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {data.skills.map((s) => {
                const fixed = fixedSkills.has(s.id);
                const allowed = cls.skillChoices.from.includes(s.id) || ['half-elf', 'human', 'elf'].includes(b.species);
                return (
                  <label key={s.id} className={`flex items-center gap-2 text-sm ${!allowed && !fixed ? 'opacity-40' : ''}`}>
                    <input
                      type="checkbox"
                      className="accent-indigo-500"
                      disabled={fixed || !allowed}
                      checked={fixed || chosen.has(s.id)}
                      onChange={() => set({ skills: toggle(b.skills, s.id, 8) })}
                    />
                    {s.name} <span className="text-xs text-slate-500">{s.ability.toUpperCase()}</span>
                    {fixed && <span className="text-[10px] text-indigo-300">background</span>}
                  </label>
                );
              })}
            </div>
          </Step>
        )}

        {cls && lv && (
          <Step n={7} title="Spells">
            <SpellPicker
              title={`Cantrips (${(b.cantrips ?? []).length}/${lv.cantrips ?? 0})`}
              list={spells.filter((s) => s.level === 0)}
              value={b.cantrips ?? []}
              onChange={(v) => set({ cantrips: v })}
            />
            <SpellPicker
              title={`Spells up to level ${maxSlot} (${(b.spells ?? []).length}${lv.known ? `/${lv.known} known` : lv.prepared ? `/${lv.prepared} prepared` : ''})`}
              list={spells.filter((s) => s.level > 0 && s.level <= maxSlot)}
              value={b.spells ?? []}
              onChange={(v) => set({ spells: v })}
            />
          </Step>
        )}

        <Step n={8} title="Equipment">
          <p className="text-xs text-slate-500">One item per line ("2× Dagger", "15 gp"). Suggestions from your class and background:</p>
          <ul className="list-disc pl-5 text-xs text-slate-400">
            {[...(cls?.equipment ?? []), ...(bg?.equipment ?? [])].map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <textarea className="input h-28 font-mono" value={(b.equipment ?? []).join('\n')} onChange={(e) => set({ equipment: e.target.value.split('\n') })} />
        </Step>

        <Step n={9} title="Story">
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">Alignment</span>
              <input className="input" value={b.alignment ?? ''} onChange={(e) => set({ alignment: e.target.value })} />
            </label>
            <label>
              <span className="label">Appearance (also used for portraits)</span>
              <input className="input" value={b.appearance ?? ''} onChange={(e) => set({ appearance: e.target.value })} />
            </label>
          </div>
          <label>
            <span className="label">Personality</span>
            <textarea className="input h-16" value={b.personality ?? ''} onChange={(e) => set({ personality: e.target.value })} />
          </label>
          <label>
            <span className="label">Backstory</span>
            <textarea className="input h-28" value={b.backstory ?? ''} onChange={(e) => set({ backstory: e.target.value })} />
          </label>
        </Step>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <div className="card">
          {check.errors.length > 0 ? (
            <ul className="space-y-1 text-sm text-amber-300">
              {check.errors.map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          ) : check.character && check.derived ? (
            <Sheet c={{ ...check.character, name: b.name || 'Unnamed' }} d={check.derived} compact />
          ) : (
            <p className="text-sm text-slate-400">Checking…</p>
          )}
        </div>
        <button className="btn w-full" disabled={saving || check.errors.length > 0 || !check.character} onClick={save}>
          {characterId ? 'Save changes' : 'Create character'}
        </button>
      </aside>
    </div>
  );
}

function BonusPicker({ label, options, value, pattern, onChange }: { label: string; options: Ability[]; value: Partial<Abilities>; pattern: number[] | '2024'; onChange: (v: Partial<Abilities>) => void }) {
  const steps = pattern === '2024' ? [0, 1, 2] : [0, 1];
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((a) => (
          <label key={a} className="flex items-center gap-1 text-sm">
            {a.toUpperCase()}
            <select className="input w-16 py-1" value={value[a] ?? 0} onChange={(e) => onChange({ ...value, [a]: Number(e.target.value) || undefined })}>
              {steps.map((s) => (
                <option key={s} value={s}>
                  +{s}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

function AsiPicker({ build, onChange }: { build: CharacterBuild; onChange: (asi: Partial<Abilities>) => void }) {
  const asi = build.asi ?? {};
  return (
    <div>
      <span className="label">Ability Score Improvements (+2 per improvement your class has had)</span>
      <div className="flex flex-wrap gap-2">
        {ABILITIES.map((a) => (
          <label key={a} className="flex items-center gap-1 text-sm">
            {a.toUpperCase()}
            <input className="input w-16 py-1" type="number" min={0} max={10} value={asi[a] ?? 0} onChange={(e) => onChange({ ...asi, [a]: Math.max(0, Number(e.target.value) || 0) || undefined })} />
          </label>
        ))}
      </div>
    </div>
  );
}

function SpellPicker({ title, list, value, onChange }: { title: string; list: { id: string; name: string; level: number; school: string; desc: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const shown = list.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="label mb-0">{title}</span>
        <input className="input ml-auto w-40 py-1" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="scroll-thin grid max-h-56 grid-cols-1 gap-x-3 overflow-y-auto sm:grid-cols-2">
        {shown.map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-sm" title={s.desc.slice(0, 400)}>
            <input type="checkbox" className="accent-indigo-500" checked={value.includes(s.id)} onChange={() => onChange(value.includes(s.id) ? value.filter((x) => x !== s.id) : [...value, s.id])} />
            {s.name}
            <span className="text-[10px] text-slate-500">
              {s.level ? `L${s.level}` : ''} {s.school}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
