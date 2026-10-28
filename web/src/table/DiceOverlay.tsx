import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '@dungeonmind/shared';
import { useMe } from '../me';
import { getSocket } from '../socket';

interface Show {
  id: number;
  label: string;
  faces: { sides: number; value: number; dropped?: boolean }[];
  total: number;
  crit?: boolean;
  fumble?: boolean;
  manual?: boolean;
}

let box: any;
let boxReady: Promise<any> | undefined;

/** The 3D dice (lazy: the physics engine only loads on the first roll). */
function diceBox(): Promise<any> {
  if (!boxReady)
    boxReady = import('@3d-dice/dice-box').then(async ({ default: DiceBox }) => {
      box = new DiceBox({ container: '#dm-dice-box', assetPath: '/assets/dice-box/', theme: 'default', themeColor: '#6366f1', scale: 6, gravity: 2, offscreen: true });
      await box.init();
      return box;
    });
  return boxReady;
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function Face({ sides, value, dropped }: { sides: number; value: number; dropped?: boolean }) {
  const shape = sides === 20 ? 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)' : sides === 4 ? 'polygon(50% 0, 100% 100%, 0 100%)' : sides === 8 ? 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)' : sides === 12 || sides === 10 ? 'polygon(50% 0, 95% 30%, 80% 100%, 20% 100%, 5% 30%)' : 'inset(0 round 18%)';
  return (
    <span className={`dm-face relative flex h-16 w-16 items-center justify-center ${dropped ? 'opacity-30' : ''}`}>
      <span className="absolute inset-0 bg-gradient-to-br from-indigo-400 to-indigo-700" style={{ clipPath: shape }} />
      <span className="relative font-serif text-2xl font-bold text-white drop-shadow">{value}</span>
      <span className="absolute -bottom-4 text-[10px] text-slate-400">d{sides}</span>
    </span>
  );
}

/**
 * Every roll at the table shows up for everyone: a short physics tumble, then the server's real faces.
 * (dice-box can't force results, so the tumble only sets the mood; the numbers are always the server's.)
 */
export function DiceOverlay({ gameId }: { gameId: string }) {
  const me = useMe();
  const [show, setShow] = useState<Show | null>(null);
  const queue = useRef<Show[]>([]);
  const busy = useRef(false);
  const off = (me.prefs as { animations?: boolean }).animations === false;

  useEffect(() => {
    const s = getSocket();
    const next = async () => {
      if (busy.current) return;
      const item = queue.current.shift();
      if (!item) return;
      busy.current = true;
      try {
        if (!reduced()) {
          const b = await Promise.race([diceBox(), new Promise((r) => setTimeout(r, 1500))]).catch(() => undefined);
          const counts = new Map<number, number>();
          for (const f of item.faces) counts.set(f.sides, (counts.get(f.sides) ?? 0) + 1);
          if (b) {
            b.show?.();
            b.roll([...counts].map(([sides, qty]) => ({ sides, qty: Math.min(qty, 10) })));
            await new Promise((r) => setTimeout(r, 1100));
            b.clear();
            b.hide?.();
          }
        }
        setShow(item);
        await new Promise((r) => setTimeout(r, 1700));
        setShow(null);
      } finally {
        busy.current = false;
        next();
      }
    };
    const onLog = (m: { gameId: string; entry: LogEntry }) => {
      if (off || m.gameId !== gameId || m.entry.kind !== 'roll' || !Array.isArray(m.entry.data?.dice) || !(m.entry.data!.dice as number[]).length) return;
      const d = m.entry.data as { dice: number[]; total: number; kind: string; crit?: boolean; manual?: boolean };
      const sides = d.kind === 'damage' || d.kind === 'heal' ? Number(/d(\d+)/.exec(m.entry.text)?.[1] ?? 6) : 20;
      queue.current.push({
        id: m.entry.id,
        label: m.entry.text.split(':')[0],
        faces: d.dice.slice(0, 12).map((value) => ({ sides, value })),
        total: d.total,
        crit: d.kind === 'attack' && d.crit,
        fumble: d.kind !== 'damage' && d.kind !== 'heal' && d.dice.length === 1 && d.dice[0] === 1,
        manual: d.manual,
      });
      if (queue.current.length > 4) queue.current.splice(0, queue.current.length - 4);
      next();
    };
    s.on('game:log', onLog);
    return () => void s.off('game:log', onLog);
  }, [gameId, off]);

  return (
    <>
      <div id="dm-dice-box" className="pointer-events-none fixed inset-0 z-30 [&>canvas]:h-full [&>canvas]:w-full" />
      {show && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center">
          <div className={`dm-reveal flex flex-col items-center gap-3 rounded-2xl border px-6 py-4 shadow-2xl backdrop-blur ${show.crit ? 'dm-crit border-amber-400 bg-amber-950/70' : show.fumble ? 'border-red-700 bg-red-950/70' : 'border-indigo-500 bg-[#0d1117]/80'}`}>
            <span className="text-sm text-slate-300">{show.label}</span>
            <div className="flex flex-wrap justify-center gap-3">
              {show.faces.map((f, i) => (
                <Face key={i} {...f} />
              ))}
            </div>
            <span className="mt-2 font-serif text-3xl font-bold text-white">
              {show.total}
              {show.crit && <span className="ml-2 text-amber-300">Critical!</span>}
              {show.manual && <span className="ml-2 text-sm text-slate-400">✋ own dice</span>}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
