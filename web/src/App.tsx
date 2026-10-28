import { useEffect, useState } from 'react';
import type { Me } from '@dungeonmind/shared';
import { api } from './api';
import { Toasts } from './components/Toasts';
import { MeContext } from './me';
import { AgeGate } from './pages/AgeGate';
import { Lobby } from './pages/Lobby';
import { Login } from './pages/Login';
import { SettingsPage } from './pages/Settings';
import { GameSetup } from './pages/GameSetup';
import { Table } from './table/Table';
import { NewAdventure } from './pages/NewAdventure';
import { CharacterLibrary, CharacterView, NewCharacter } from './pages/Characters';
import { match, navigate, usePath } from './router';
import { closeSocket, getSocket } from './socket';

const NAV: [string, string][] = [
  ['/', 'Lobby'],
  ['/characters', 'Characters'],
  ['/settings', 'Settings'],
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [auth, setAuth] = useState<{ needsSetup: boolean; registration: boolean }>({ needsSetup: false, registration: true });
  const path = usePath();

  const load = async () => {
    setAuth(await api('/api/auth/config', { quiet: true }).catch(() => ({ needsSetup: false, registration: true })));
    setMe(await api<Me>('/api/auth/me', { quiet: true }).catch(() => null));
  };
  useEffect(() => {
    load();
  }, []);

  // Readability prefs live on <html> so every story text picks them up.
  useEffect(() => {
    const p = (me?.prefs ?? {}) as Record<string, string>;
    const html = document.documentElement;
    html.dataset.fontSize = p.fontSize ?? 'md';
    html.dataset.line = p.lineSpacing ?? 'normal';
    html.dataset.dyslexia = p.dyslexia ? '1' : '0';
  }, [me]);

  // Tell the lobby where we are (presence).
  useEffect(() => {
    if (!me?.adult) return;
    getSocket().emit('where', path.startsWith('/table/') ? `game:${path.split('/')[2]}` : path === '/' ? 'lobby' : path.slice(1).split('/')[0]);
  }, [me, path]);

  if (me === undefined) return null;
  if (!me)
    return (
      <>
        <Login setup={auth.needsSetup} registration={auth.registration} onDone={load} />
        <Toasts />
      </>
    );
  if (!me.adult) return <AgeGate onDone={load} logoutUrl={me.logoutUrl} />;

  const logout = async () => {
    closeSocket();
    if (me.authMode === 'header') {
      location.href = me.logoutUrl || '/';
      return;
    }
    await api('/api/auth/logout', { method: 'POST' });
    setMe(null);
  };

  const table = match('/table/:id', path);
  const gameSetup = match('/games/:id', path);
  const charView = match('/characters/:id', path);
  const charEdit = match('/characters/:id/edit', path);

  return (
    <MeContext.Provider value={me}>
      <div className={`mx-auto ${table ? 'max-w-none' : 'max-w-7xl p-3 sm:p-4'}`}>
        {!table && (
          <header className="mb-4 flex flex-wrap items-center gap-2">
            <button onClick={() => navigate('/')} className="flex items-center gap-2">
              <img src="/icon.svg" className="h-8 w-8" alt="" />
              <span className="font-serif text-xl font-semibold tracking-wide text-indigo-100">DungeonMind</span>
            </button>
            <nav className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:ml-4 sm:w-auto">
              {NAV.map(([to, label]) => (
                <button
                  key={to}
                  onClick={() => navigate(to)}
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${(to === '/' ? path === '/' : path.startsWith(to)) ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}
                >
                  {label}
                </button>
              ))}
            </nav>
            <span className="ml-auto text-sm text-slate-400">
              {me.username}
              {me.role === 'admin' && <span className="ml-1.5 rounded bg-[#21262d] px-1.5 py-0.5 text-xs">admin</span>}
            </span>
            <button className="btn-ghost" onClick={logout}>
              Log out
            </button>
          </header>
        )}
        {path === '/' && <Lobby />}
        {path === '/settings' && <SettingsPage />}
        {table && <Table id={table.id} />}
        {path === '/adventures/new' && <NewAdventure />}
        {gameSetup && <GameSetup id={gameSetup.id} />}
        {path === '/characters' && <CharacterLibrary />}
        {path === '/characters/new' && <NewCharacter />}
        {charView && charView.id !== 'new' && <CharacterView id={charView.id} />}
        {charEdit && <CharacterView id={charEdit.id} edit />}
      </div>
      <Toasts />
    </MeContext.Provider>
  );
}
