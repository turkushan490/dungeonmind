import { useEffect, useState } from 'react';

/** A tiny path router: /, /characters, /table/:id, … (the server sends index.html for all of them). */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    addEventListener('dm-navigate', on);
    return () => {
      removeEventListener('popstate', on);
      removeEventListener('dm-navigate', on);
    };
  }, []);
  return path;
}

export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, '', to);
  dispatchEvent(new Event('dm-navigate'));
  scrollTo(0, 0);
}

/** "/table/:id" against "/table/abc" → { id: "abc" }, or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) out[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}
