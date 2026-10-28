import { useState } from 'react';
import type { Character } from '@dungeonmind/shared';
import { api, upload } from '../api';

const STYLES = ['painterly dark fantasy', 'ink and watercolor', 'grim oil painting', 'charcoal sketch', 'heroic illustration'];

/** 4 options from HiveMind (ComfyUI), regenerate, or upload your own. */
export function PortraitPicker({ c, onChanged }: { c: Character; onChanged: (c: Character) => void }) {
  const [style, setStyle] = useState(STYLES[0]);
  const [options, setOptions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      setOptions((await api<{ options: string[] }>(`/api/characters/${c.id}/portraits`, { body: { style } })).options);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">Portrait</h2>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto" value={style} onChange={(e) => setStyle(e.target.value)}>
          {STYLES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button className="btn" disabled={busy} onClick={generate}>
          {busy ? <span className="dm-breathe">Painting…</span> : options.length ? 'Regenerate' : 'Make 4 portraits'}
        </button>
        <label className="btn-ghost cursor-pointer">
          Upload my own
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) onChanged(await upload<Character>(`/api/characters/${c.id}/portrait/upload`, f));
            }}
          />
        </label>
      </div>
      <p className="text-xs text-slate-500">Uses the appearance from the Story section. Needs an image model (ComfyUI) on the dnd-portrait canvas in HiveMind.</p>
      {options.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {options.map((o) => (
            <button key={o} className={`dm-pop overflow-hidden rounded-lg border-2 ${c.portrait === o ? 'border-indigo-400' : 'border-transparent hover:border-indigo-700'}`} onClick={async () => onChanged(await api<Character>(`/api/characters/${c.id}/portrait`, { body: { url: o } }))}>
              <img src={o} alt="Portrait option" className="aspect-[3/4] w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
