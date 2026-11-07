import { useEffect, useRef, useState } from 'react';
import type { DieFace, LogEntry } from '@dungeonmind/shared';
import { useMe } from '../me';
import { getSocket } from '../socket';

interface Show {
  id: number;
  label: string;
  faces: DieFace[];
  total: number;
  adv?: 'adv' | 'dis';
  crit?: boolean;
  fumble?: boolean;
  manual?: boolean;
}

/** How long the dice tumble before they land, and how long the result stays up. */
const ROLL_MS = 900;
const HOLD_MS = 1700;

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Die sizes the 3D dice reliably land on. A roll with any other die (d4, d100) uses the 2D dice. */
const DICE_3D = [6, 8, 10, 12, 20];

let boxReady: Promise<any> | undefined;
let boxIn: Element | null = null;

/** The 3D dice (lazy: three.js only loads on the first 3D roll). Rebuilt when the table mounted a new container. */
function diceBox(): Promise<any> {
  const el = document.getElementById('dm-dice-3d');
  if (boxReady && boxIn === el) return boxReady;
  boxIn = el;
  boxReady = import('@3d-dice/dice-box-threejs').then(async ({ default: DiceBox }) => {
    const box = new DiceBox('#dm-dice-3d', {
      sounds: false,
      gravity_multiplier: 1600,
      strength: 0.5,
      theme_customColorset: { name: 'dungeonmind', foreground: '#ffffff', background: '#4f46e5', outline: '#312e81', texture: 'none', material: 'plastic' },
    });
    await box.initialize();
    return box;
  });
  return boxReady;
}

/**
 * "2d6+1d20@3,5,17": the server's faces for the 3D dice to land on. dice-box-threejs merges dice of the
 * same size into one group, so the values go in grouped by size.
 */
export function forcedNotation(faces: DieFace[]): string {
  const groups = new Map<number, number[]>();
  for (const f of faces) groups.set(f.sides, [...(groups.get(f.sides) ?? []), f.value]);
  return `${[...groups].map(([sides, v]) => `${v.length}d${sides}`).join('+')}@${[...groups.values()].flat().join(',')}`;
}

/** Throws the 3D dice onto the server's faces. False when they can't (still loading, failed): use the 2D dice. */
async function roll3d(faces: DieFace[]): Promise<boolean> {
  const box = await Promise.race([diceBox(), wait(2000)]).catch(() => undefined);
  if (!box) return false;
  await Promise.race([box.roll(forcedNotation(faces)), wait(4000)]);
  return true;
}

/** While rolling the die spins through random faces; then it lands on the server's value. */
function Face({ sides, value, dropped, rolling }: DieFace & { rolling: boolean }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (!rolling) {
      setShown(value);
      return;
    }
    const t = setInterval(() => setShown(1 + Math.floor(Math.random() * sides)), 70);
    return () => clearInterval(t);
  }, [rolling, sides, value]);
  const shape = sides === 20 ? 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)' : sides === 4 ? 'polygon(50% 0, 100% 100%, 0 100%)' : sides === 8 ? 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)' : sides === 12 || sides === 10 ? 'polygon(50% 0, 95% 30%, 80% 100%, 20% 100%, 5% 30%)' : 'inset(0 round 18%)';
  const dim = !rolling && dropped;
  return (
    // The dim sits outside the animated span: dm-land ends at full opacity and would cancel it.
    <span className={`relative flex h-16 w-16 items-center justify-center ${dim ? 'opacity-30' : ''}`}>
      <span className={`absolute inset-0 flex items-center justify-center ${rolling ? 'dm-tumble' : 'dm-land'}`}>
        <span className="absolute inset-0 bg-gradient-to-br from-indigo-400 to-indigo-700" style={{ clipPath: shape }} />
        <span className={`relative font-serif text-2xl font-bold text-white drop-shadow ${dim ? 'line-through' : ''}`}>{shown}</span>
      </span>
      <span className="absolute -bottom-4 whitespace-nowrap text-[10px] text-slate-400">
        d{sides}
        {dim && ' · dropped'}
      </span>
    </span>
  );
}

/** Rolls logged before the server sent faces: guess the die size from the log text. */
function guessFaces(entry: LogEntry, d: { dice: number[]; kind: string }): DieFace[] {
  const sides = d.kind === 'damage' || d.kind === 'heal' ? Number(/d(\d+)/.exec(entry.text)?.[1] ?? 6) : 20;
  return d.dice.map((value) => ({ sides, value }));
}

/**
 * Every roll at the table shows up for everyone: the dice tumble, then land on the server's real faces.
 * With "3D dice" on, physics dice land on those faces first. Dropped dice (advantage, disadvantage,
 * 4d6kh3) stay visible but dimmed.
 */
export function DiceOverlay({ gameId }: { gameId: string }) {
  const me = useMe();
  const [show, setShow] = useState<Show | null>(null);
  const [rolling, setRolling] = useState(false);
  // After a 3D roll the result sits low on the screen, so the dice on the table stay in view.
  const [low, setLow] = useState(false);
  const queue = useRef<Show[]>([]);
  const busy = useRef(false);
  const prefs = me.prefs as { animations?: boolean; dice3d?: boolean };
  const off = prefs.animations === false;
  const fancy = !off && !!prefs.dice3d;

  useEffect(() => {
    const s = getSocket();
    const next = async () => {
      if (busy.current) return;
      const item = queue.current.shift();
      if (!item) return;
      busy.current = true;
      try {
        const tumble = !reduced();
        if (tumble && fancy && item.faces.every((f) => DICE_3D.includes(f.sides)) && (await roll3d(item.faces))) {
          setRolling(false);
          setLow(true);
          setShow(item);
          await wait(HOLD_MS);
          setShow(null);
          (await diceBox()).clearDice();
          return;
        }
        setLow(false);
        setRolling(tumble);
        setShow(item);
        if (tumble) {
          await wait(ROLL_MS);
          setRolling(false);
        }
        await wait(HOLD_MS);
        setShow(null);
      } finally {
        busy.current = false;
        next();
      }
    };
    const onLog = (m: { gameId: string; entry: LogEntry }) => {
      if (off || m.gameId !== gameId || m.entry.kind !== 'roll' || !Array.isArray(m.entry.data?.dice) || !(m.entry.data!.dice as number[]).length) return;
      const d = m.entry.data as { dice: number[]; faces?: DieFace[]; total: number; kind: string; adv?: string; crit?: boolean; fumble?: boolean; manual?: boolean };
      const faces = Array.isArray(d.faces) && d.faces.length ? d.faces : guessFaces(m.entry, d);
      queue.current.push({
        id: m.entry.id,
        label: m.entry.text.split(':')[0],
        faces: faces.slice(0, 12),
        total: d.total,
        adv: d.adv === 'adv' || d.adv === 'dis' ? d.adv : undefined,
        crit: d.kind === 'attack' && d.crit,
        fumble: d.fumble ?? (d.kind !== 'damage' && d.kind !== 'heal' && d.dice.length === 1 && d.dice[0] === 1),
        manual: d.manual,
      });
      if (queue.current.length > 4) queue.current.splice(0, queue.current.length - 4);
      next();
    };
    s.on('game:log', onLog);
    return () => void s.off('game:log', onLog);
  }, [gameId, off, fancy]);

  const landed = !rolling;
  return (
    <>
      {fancy && <div id="dm-dice-3d" className="pointer-events-none fixed inset-0 z-30" />}
      {show && (
        <div className={`pointer-events-none fixed inset-0 z-40 flex justify-center ${low ? 'items-end pb-16' : 'items-center'}`}>
          <div className={`dm-reveal flex flex-col items-center gap-3 rounded-2xl border px-6 py-4 shadow-2xl backdrop-blur ${landed && show.crit ? 'dm-crit border-amber-400 bg-amber-950/70' : landed && show.fumble ? 'border-red-700 bg-red-950/70' : 'border-indigo-500 bg-[#0d1117]/80'}`}>
            <span className="text-sm text-slate-300">{show.label}</span>
            {show.adv && <span className="-mt-2 text-xs text-slate-400">{show.adv === 'adv' ? 'Advantage: the higher die counts' : 'Disadvantage: the lower die counts'}</span>}
            <div className="flex flex-wrap justify-center gap-3">
              {show.faces.map((f, i) => (
                <Face key={i} {...f} rolling={rolling} />
              ))}
            </div>
            <span className={`mt-2 font-serif text-3xl font-bold text-white ${landed ? 'dm-land' : 'opacity-0'}`}>
              {show.total}
              {landed && show.crit && <span className="ml-2 text-amber-300">Critical!</span>}
              {show.manual && <span className="ml-2 text-sm text-slate-400">✋ own dice</span>}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
