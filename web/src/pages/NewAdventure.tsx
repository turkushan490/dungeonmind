import { useState } from 'react';
import { RULESET_NAMES, type Ruleset } from '@dungeonmind/shared';
import { api } from '../api';
import { navigate } from '../router';

export function SettingsFields({ v, set, locked }: { v: Record<string, any>; set: (patch: Record<string, any>) => void; locked?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label>
        <span className="label">Start level</span>
        <input className="input" type="number" min={1} max={20} disabled={locked} value={v.startLevel} onChange={(e) => set({ startLevel: Number(e.target.value) })} />
      </label>
      <label>
        <span className="label">End level (cap)</span>
        <input className="input" type="number" min={1} max={20} disabled={locked} value={v.endLevel} onChange={(e) => set({ endLevel: Number(e.target.value) })} />
      </label>
      <label>
        <span className="label">Max players</span>
        <input className="input" type="number" min={1} max={8} disabled={locked} value={v.maxPlayers} onChange={(e) => set({ maxPlayers: Number(e.target.value) })} />
      </label>
      <label>
        <span className="label">Group rerolls</span>
        <input className="input" type="number" min={0} max={99} disabled={locked} value={v.rerolls} onChange={(e) => set({ rerolls: Number(e.target.value) })} />
      </label>
      <label>
        <span className="label">Advancement</span>
        <select className="input" disabled={locked} value={v.xpMode} onChange={(e) => set({ xpMode: e.target.value })}>
          <option value="xp">XP</option>
          <option value="milestone">Milestones</option>
        </select>
      </label>
      <label>
        <span className="label">Spectators</span>
        <select className="input" value={v.visibility} onChange={(e) => set({ visibility: e.target.value })}>
          <option value="public">Public (anyone can watch)</option>
          <option value="private">Private</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-indigo-500" disabled={locked} checked={v.multiChars} onChange={(e) => set({ multiChars: e.target.checked })} />
        Players may run more than one character
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-indigo-500" disabled={locked} checked={v.allowManualScores} onChange={(e) => set({ allowManualScores: e.target.checked })} />
        Allow typed-in ability scores (imports)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-indigo-500" checked={v.sceneImages !== false} onChange={(e) => set({ sceneImages: e.target.checked })} />
        Illustrate new scenes (HiveMind images)
      </label>
      <label className="flex items-center gap-2 text-sm" title="The DM's prompts and answers of this game may be exported as training data for HiveMind's Lab">
        <input type="checkbox" className="accent-indigo-500" checked={!!v.labExport} onChange={(e) => set({ labExport: e.target.checked })} />
        Share this game's DM turns with the Lab (opt-in)
      </label>
    </div>
  );
}

export function NewAdventure() {
  const [v, setV] = useState({ name: '', ruleset: 'srd51' as Ruleset, startLevel: 1, endLevel: 5, maxPlayers: 4, rerolls: 3, xpMode: 'xp', visibility: 'public', multiChars: false, allowManualScores: false });
  const set = (p: Record<string, any>) => setV({ ...v, ...p });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="card space-y-3">
        <h2 className="rune-title">A new adventure</h2>
        <div className="rune-rule" />
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className="label">Ruleset</span>
            <select className="input" value={v.ruleset} onChange={(e) => set({ ruleset: e.target.value })}>
              {Object.entries(RULESET_NAMES).map(([k, n]) => (
                <option key={k} value={k}>
                  {n}
                </option>
              ))}
              <option disabled>Pathfinder 2e (later)</option>
            </select>
          </label>
          <label>
            <span className="label">Working title</span>
            <input className="input" placeholder="The AI can name it later" value={v.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
        </div>
        <SettingsFields v={v} set={set} />
        <button className="btn" onClick={async () => navigate(`/games/${(await api<{ id: string }>('/api/games', { body: v })).id}`)}>
          Create and set up
        </button>
      </section>
    </div>
  );
}
