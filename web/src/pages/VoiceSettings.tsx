import { useEffect, useState } from 'react';
import { api } from '../api';
import { useMe } from '../me';
import { readAloud, type NarratorPrefs } from '../table/narrator';

interface Status {
  engine: 'kokoro' | 'chatterbox' | 'off';
  narrator: string;
  retentionDays: number;
  ffmpeg: boolean;
  voices: { id: string; name: string; gender: string; accent: string; tags: string[]; grade: string }[];
}

const SAMPLE = 'The torches gutter as you step into the crypt. Somewhere below, stone grinds on stone. "Who disturbs the dead?" a dry voice asks.';

/** Per user: narrator voice, speed, volume, autoplay, highlighting. Admin: engine, default voice, audio retention. */
export function VoiceSettings() {
  const me = useMe();
  const [s, setS] = useState<Status>();
  const [p, setP] = useState<NarratorPrefs>((me.prefs.narrator as NarratorPrefs) ?? {});
  const [sample, setSample] = useState(SAMPLE);
  useEffect(() => {
    api<Status>('/api/tts/status').then(setS);
  }, []);
  const save = async (patch: NarratorPrefs) => {
    const next = { ...p, ...patch };
    setP(next);
    const prefs = await api('/api/me/prefs', { method: 'PUT', body: { narrator: next } });
    Object.assign(me.prefs, prefs);
  };
  const admin = async (patch: Partial<Status>) => setS({ ...s!, ...(await api('/api/settings/tts', { method: 'PUT', body: patch })) });
  if (!s) return null;
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">Narrator voice</h2>
      {s.engine === 'off' && <p className="text-sm text-amber-300">The admin turned the narrator voice off.</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="label">Narrator</span>
          <select className="input" value={p.voice ?? s.narrator} onChange={(e) => save({ voice: e.target.value })}>
            {s.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.gender}, {v.accent === 'gb' ? 'British' : 'American'}) {v.tags.includes('narrator') ? '★' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Speed {(p.speed ?? 1).toFixed(2)}×</span>
          <input type="range" className="w-full accent-indigo-500" min={0.7} max={1.4} step={0.05} value={p.speed ?? 1} onChange={(e) => save({ speed: Number(e.target.value) })} />
        </label>
        <label>
          <span className="label">Volume {Math.round((p.volume ?? 1) * 100)}%</span>
          <input type="range" className="w-full accent-indigo-500" min={0} max={1} step={0.05} value={p.volume ?? 1} onChange={(e) => save({ volume: Number(e.target.value) })} />
        </label>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-indigo-500" checked={!!p.autoplay} onChange={(e) => save({ autoplay: e.target.checked })} />
          Read new narration aloud automatically
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-indigo-500" checked={p.highlight !== false} onChange={(e) => save({ highlight: e.target.checked })} />
          Highlight the spoken word
        </label>
      </div>
      <div className="space-y-2">
        <span className="label">Listening test</span>
        <textarea className="input readable h-20" value={sample} onChange={(e) => setSample(e.target.value)} />
        <button className="btn-ghost" disabled={s.engine === 'off'} onClick={() => readAloud(sample, p)}>
          ▶ Listen ({s.engine})
        </button>
        <p className="text-xs text-slate-500">Tip: select any text in the story and press “Read this aloud”. NPCs get their own voices automatically; monsters get effects{s.ffmpeg ? '' : ' (needs ffmpeg, missing here)'}.</p>
      </div>
      {me.role === 'admin' && (
        <div className="grid gap-3 border-t border-[#30363d] pt-3 sm:grid-cols-3">
          <label>
            <span className="label">Engine (admin)</span>
            <select className="input" value={s.engine} onChange={(e) => admin({ engine: e.target.value as Status['engine'] })}>
              <option value="kokoro">Kokoro (built in, CPU)</option>
              <option value="chatterbox">Chatterbox (:full image)</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label>
            <span className="label">Default narrator (admin)</span>
            <select className="input" value={s.narrator} onChange={(e) => admin({ narrator: e.target.value })}>
              {s.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Keep audio (days, 0 = forever)</span>
            <input className="input" type="number" min={0} value={s.retentionDays} onChange={(e) => admin({ retentionDays: Number(e.target.value) })} />
          </label>
        </div>
      )}
    </section>
  );
}
