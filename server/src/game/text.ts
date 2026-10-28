export const titleCase = (id: string) => id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
/** Loose name matching for what the AI writes ("esvahanna", "Esvahanna the Pale"). */
export const sameName = (a: string | undefined, b: string | undefined) => {
  if (!a || !b) return false;
  const norm = (s: string) => s.toLowerCase().trim().replace(/^(the|a|an)\s+/, '');
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const fx = x.split(/\s+/)[0];
  return fx.length > 2 && fx === y.split(/\s+/)[0] && (!x.includes(' ') || !y.includes(' '));
};
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
