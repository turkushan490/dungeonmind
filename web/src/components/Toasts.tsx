import { useEffect, useState } from 'react';
import { onToast } from '../notify';

export function Toasts() {
  const [list, setList] = useState<{ id: number; text: string; kind: 'error' | 'info' }[]>([]);
  useEffect(
    () =>
      onToast((m) => {
        setList((l) => [...l.slice(-3), m]);
        setTimeout(() => setList((l) => l.filter((x) => x.id !== m.id)), 6000);
      }),
    [],
  );
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
      {list.map((m) => (
        <div
          key={m.id}
          role="status"
          className={`dm-pop pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-lg ${m.kind === 'error' ? 'border-red-800 bg-red-950 text-red-100' : 'border-indigo-700 bg-[#161b22] text-slate-100'}`}
        >
          {m.text}
        </div>
      ))}
    </div>
  );
}
