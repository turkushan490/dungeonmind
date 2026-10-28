import { useEffect, useState } from 'react';
import { RULESET_NAMES, type Ruleset } from '@dungeonmind/shared';
import { api } from '../api';
import { useMe } from '../me';

type Kind = 'spell' | 'item' | 'monster' | 'feat' | 'condition' | 'rule' | 'species' | 'background';
interface Entry {
  id: string;
  ownerId: string;
  owner: string;
  ruleset: Ruleset;
  kind: Kind;
  name: string;
  data: Record<string, any>;
  enabled: boolean;
}

/** Form fields per kind: [key, label, type, hint]. Lists are comma separated. */
const FIELDS: Record<Kind, [string, string, 'text' | 'number' | 'area' | 'check', string?][]> = {
  spell: [
    ['name', 'Name', 'text'],
    ['level', 'Level (0 = cantrip)', 'number'],
    ['school', 'School', 'text'],
    ['classes', 'Classes', 'text', 'cleric, wizard'],
    ['castingTime', 'Casting time', 'text'],
    ['range', 'Range', 'text'],
    ['duration', 'Duration', 'text'],
    ['components', 'Components', 'text'],
    ['damage', 'Damage', 'text', '2d6 necrotic'],
    ['concentration', 'Concentration', 'check'],
    ['ritual', 'Ritual', 'check'],
    ['desc', 'What it does', 'area'],
  ],
  item: [
    ['name', 'Name', 'text'],
    ['category', 'Category', 'text', 'Wondrous Item, Martial Melee Weapons, Armor…'],
    ['rarity', 'Rarity', 'text'],
    ['magic', 'Magic item', 'check'],
    ['damage', 'Weapon damage', 'text', '1d8'],
    ['damageType', 'Damage type', 'text'],
    ['properties', 'Properties', 'text', 'finesse, light'],
    ['armorBase', 'Armor: base AC', 'number'],
    ['maxBonus', 'Armor: max DEX bonus (empty = no limit)', 'number'],
    ['cost', 'Cost', 'text'],
    ['desc', 'Description', 'area'],
  ],
  monster: [
    ['name', 'Name', 'text'],
    ['size', 'Size', 'text'],
    ['type', 'Type', 'text'],
    ['ac', 'AC', 'number'],
    ['hp', 'HP', 'number'],
    ['hitDice', 'Hit dice', 'text'],
    ['speed', 'Speed', 'text'],
    ['str', 'STR', 'number'],
    ['dex', 'DEX', 'number'],
    ['con', 'CON', 'number'],
    ['int', 'INT', 'number'],
    ['wis', 'WIS', 'number'],
    ['cha', 'CHA', 'number'],
    ['cr', 'Challenge rating', 'number'],
    ['xp', 'XP', 'number'],
    ['traits', 'Traits (comma separated)', 'area'],
    ['actions', 'Actions (comma separated)', 'area'],
  ],
  feat: [
    ['name', 'Name', 'text'],
    ['desc', 'What it does', 'area'],
  ],
  condition: [
    ['name', 'Name', 'text'],
    ['desc', 'Effects', 'area'],
  ],
  rule: [
    ['name', 'Name', 'text'],
    ['desc', 'The rule', 'area'],
  ],
  species: [
    ['name', 'Name', 'text'],
    ['speed', 'Speed', 'number'],
    ['size', 'Size', 'text'],
    ['traits', 'Traits', 'text'],
  ],
  background: [
    ['name', 'Name', 'text'],
    ['skills', 'Skills (2)', 'text', 'stealth, insight'],
    ['abilityOptions', '2024: abilities for the +2/+1', 'text', 'dex, int, wis'],
    ['feat', '2024: origin feat', 'text'],
    ['equipment', 'Equipment', 'text'],
  ],
};

function toForm(kind: Kind, d: Record<string, any>): Record<string, any> {
  const f: Record<string, any> = { ...d };
  for (const [k] of FIELDS[kind]) if (Array.isArray(f[k])) f[k] = f[k].join(', ');
  if (kind === 'monster') Object.assign(f, d.abilities ?? {});
  if (kind === 'item' && d.armor) Object.assign(f, { armorBase: d.armor.base, maxBonus: d.armor.maxBonus ?? '' });
  return f;
}

function Editor({ ruleset, kind, entry, onDone }: { ruleset: Ruleset; kind: Kind; entry?: Entry; onDone: () => void }) {
  const [f, setF] = useState<Record<string, any>>(entry ? toForm(kind, entry.data) : {});
  const save = async () => {
    const data = { ...f };
    if (kind === 'monster') data.abilities = Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map((a) => [a, Number(f[a] ?? 10)]));
    await api(entry ? `/api/homebrew/${entry.id}` : '/api/homebrew', { method: entry ? 'PUT' : 'POST', body: entry ? { data } : { ruleset, kind, data } });
    onDone();
  };
  return (
    <div className="card space-y-2">
      <h3 className="rune-title">{entry ? `Edit ${entry.name}` : `New ${kind}`}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS[kind].map(([k, label, type, hint]) => (
          <label key={k} className={type === 'area' ? 'sm:col-span-2' : ''}>
            <span className="label">{label}</span>
            {type === 'area' ? (
              <textarea className="input h-24" value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            ) : type === 'check' ? (
              <input type="checkbox" className="accent-indigo-500" checked={!!f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />
            ) : (
              <input className="input" type={type} placeholder={hint} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })} />
            )}
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="btn" onClick={save}>
          Save
        </button>
        <button className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function HomebrewPage() {
  const me = useMe();
  const [ruleset, setRuleset] = useState<Ruleset>('srd51');
  const [kind, setKind] = useState<Kind>('spell');
  const [list, setList] = useState<Entry[]>([]);
  const [edit, setEdit] = useState<Entry | 'new' | null>(null);
  const load = () => api<Entry[]>(`/api/homebrew?ruleset=${ruleset}`).then(setList);
  useEffect(() => {
    load();
  }, [ruleset]);
  const shown = list.filter((e) => e.kind === kind);
  return (
    <div className="space-y-4">
      <section className="card space-y-2">
        <h2 className="rune-title">Homebrew</h2>
        <p className="text-sm text-slate-400">
          Your own spells, items, monsters, feats, conditions, rules, species and backgrounds. They join the rules for that ruleset: the builder offers them, the rules search finds them, and{' '}
          {me.role === 'admin' ? '"Load SRD rules into HiveMind memory" (Settings) sends them to the DM.' : 'the admin can send them to the DM’s memory.'} Hosts decide at the table what's allowed.
        </p>
        <div className="flex flex-wrap gap-2">
          <select className="input w-auto" value={ruleset} onChange={(e) => setRuleset(e.target.value as Ruleset)}>
            {Object.entries(RULESET_NAMES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1">
            {(Object.keys(FIELDS) as Kind[]).map((k) => (
              <button key={k} className={kind === k ? 'btn py-1' : 'btn-ghost py-1'} onClick={() => (setKind(k), setEdit(null))}>
                {k} {list.filter((e) => e.kind === k).length > 0 && <span className="text-xs opacity-70">({list.filter((e) => e.kind === k).length})</span>}
              </button>
            ))}
          </div>
          <button className="btn ml-auto" onClick={() => setEdit('new')}>
            New {kind}
          </button>
        </div>
      </section>
      {edit && <Editor key={edit === 'new' ? 'new' : edit.id} ruleset={ruleset} kind={kind} entry={edit === 'new' ? undefined : edit} onDone={() => (setEdit(null), load())} />}
      <section className="card">
        {shown.length === 0 && <p className="text-sm text-slate-500">No homebrew {kind}s yet.</p>}
        <ul className="divide-y divide-[#30363d]">
          {shown.map((e) => {
            const mine = e.ownerId === me.id || me.role === 'admin';
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className={`font-medium ${e.enabled ? '' : 'text-slate-500 line-through'}`}>{e.name}</span>
                <span className="text-xs text-slate-500">by {e.owner}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{e.data.desc ?? (e.kind === 'monster' ? `AC ${e.data.ac}, HP ${e.data.hp}, CR ${e.data.cr}` : '')}</span>
                {mine && (
                  <>
                    <button className="btn-ghost py-0.5 text-xs" onClick={() => setEdit(e)}>
                      Edit
                    </button>
                    <button className="btn-ghost py-0.5 text-xs" onClick={() => api(`/api/homebrew/${e.id}`, { method: 'PUT', body: { enabled: !e.enabled } }).then(load)}>
                      {e.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="btn-danger py-0.5 text-xs" onClick={() => confirm(`Delete ${e.name}?`) && api(`/api/homebrew/${e.id}`, { method: 'DELETE' }).then(load)}>
                      Delete
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
