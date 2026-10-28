type Listener = (msg: { id: number; text: string; kind: 'error' | 'info' }) => void;
const listeners = new Set<Listener>();
let next = 1;

export function toast(text: string, kind: 'error' | 'info' = 'error') {
  const msg = { id: next++, text, kind };
  listeners.forEach((l) => l(msg));
}
export const onToast = (l: Listener) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
