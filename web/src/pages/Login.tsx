import { useState, type FormEvent } from 'react';
import { api } from '../api';

/** Login mode: log in, or register. Registration includes the 18+ question. Portal mode: only the Docker admin logs in here. */
export function Login({ portal, registration, onDone }: { portal: boolean; registration: boolean; onDone: () => void }) {
  if (portal)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
        <Landing />
        <div className="card w-full max-w-sm">
          <AdminLoginForm onDone={onDone} />
        </div>
        <Attribution />
      </div>
    );
  return <LoginForm registration={registration} onDone={onDone} />;
}

const PASSWORD_HINT = 'Password (5+ characters, 1 capital, 1 symbol)';

/** Portal mode: the Docker admin account (ADMIN_USERNAME / ADMIN_PASSWORD). Its session wins over the portal until dropped. */
export function AdminLoginForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/api/auth/admin-login', { body: { username, password }, quiet: true });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-slate-400">Log in with the admin account from Docker.</p>
      <input className="input" placeholder="Admin username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input className="input" type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button className="btn w-full">Log in as admin</button>
    </form>
  );
}

function LoginForm({ registration, onDone }: { registration: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [adult, setAdult] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { body: { username, password, adult }, quiet: true });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Landing />
      <form onSubmit={submit} className="card w-full max-w-sm space-y-3">
        <p className="text-sm text-slate-400">
          {mode === 'login' ? 'Log in to play.' : 'Create your account.'}
        </p>
        <input className="input" placeholder="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          className="input"
          type="password"
          placeholder={mode === 'register' ? PASSWORD_HINT : 'Password'}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === 'register' && (
          <label className="flex items-start gap-2 text-sm text-slate-300">
            <input type="checkbox" className="mt-1 accent-indigo-500" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
            <span>I am 18 or older. DungeonMind tells dark, mature stories (violence, horror, death).</span>
          </label>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn w-full" disabled={mode === 'register' && !adult}>
          {mode === 'login' ? 'Log in' : 'Create account'}
        </button>
        {registration && (
          <button type="button" className="w-full text-center text-xs text-indigo-300 hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'No account yet? Register' : 'Have an account? Log in'}
          </button>
        )}
      </form>
      <Attribution />
    </div>
  );
}

/** The "Log in & play" landing text above the form. */
export function Landing() {
  return (
    <div className="max-w-md text-center">
      <img src="/icon.svg" className="mx-auto mb-3 h-16 w-16" alt="" />
      <h1 className="font-serif text-3xl font-semibold tracking-wide text-indigo-100">DungeonMind</h1>
      <div className="rune-rule mx-auto my-3 w-48" />
      <p className="story text-sm">
        Gather your party. An AI Dungeon Master tells the tale, the server keeps every number honest: dice, hit points, spell slots and every last use of Channel Divinity.
      </p>
      <ul className="mx-auto mt-3 grid max-w-md gap-1 text-left text-xs text-slate-400 sm:grid-cols-3">
        <li>⚔ D&amp;D 5e, 2014 and 2024 rules</li>
        <li>🎲 Server dice or your own</li>
        <li>🔊 A narrator voice for every NPC</li>
      </ul>
    </div>
  );
}

export function Attribution() {
  return (
    <p className="max-w-lg text-center text-[11px] leading-snug text-slate-500">
      DungeonMind is free software (AGPL-3.0). This work includes material from the System Reference Document 5.1 and 5.2 by Wizards of the Coast LLC, licensed under{' '}
      <a className="underline" href="https://creativecommons.org/licenses/by/4.0/legalcode" target="_blank" rel="noreferrer">
        CC-BY-4.0
      </a>
      . Rules data via the 5e-bits SRD API (MIT).
    </p>
  );
}
