import { useEffect, useState } from 'react';
import type { AuthMode, Me } from '@dungeonmind/shared';
import { api } from './api';
import { Modal } from './components/Modal';
import { Toasts } from './components/Toasts';
import { MeContext } from './me';
import { AgeGate } from './pages/AgeGate';
import { Lobby } from './pages/Lobby';
import { AdminLoginForm, Login } from './pages/Login';
import { SettingsPage } from './pages/Settings';
import { HomebrewPage } from './pages/Homebrew';
import { GuidePage } from './pages/Guide';
import { RulesPage } from './pages/Rules';
import { TrainerPage } from './pages/Trainer';
import { GameSetup } from './pages/GameSetup';
import { Table } from './table/Table';
import { NewAdventure } from './pages/NewAdventure';
import { CharacterLibrary, CharacterView, NewCharacter } from './pages/Characters';
import { match, navigate, usePath } from './router';
import { closeSocket, getSocket } from './socket';
import { isNative } from './native';

const NAV: [string, string][] = [
  ['/', 'Lobby'],
  ['/characters', 'Characters'],
  ['/homebrew', 'Homebrew'],
  ['/guide', 'Guide'],
  ['/settings', 'Settings'],
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [auth, setAuth] = useState<{ mode: AuthMode; registration: boolean }>({ mode: 'login', registration: true });
  const [adminLogin, setAdminLogin] = useState(false);
  const path = usePath();

  const load = async () => {
    setAuth(await api('/api/auth/config', { quiet: true }).catch(() => ({ mode: 'login' as AuthMode, registration: true })));
    setMe(await api<Me>('/api/auth/me', { quiet: true }).catch(() => null));
  };
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (isNative()) document.documentElement.dataset.native = '1';
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
        <Login portal={auth.mode === 'portal'} registration={auth.registration} onDone={load} />
        <Toasts />
      </>
    );
  if (!me.adult || !me.trainingAccepted) return <AgeGate onDone={load} logoutUrl={me.logoutUrl} />;

  const logout = async () => {
    closeSocket();
    await api('/api/auth/logout', { method: 'POST' });
    if (me.authMode === 'portal' && me.logoutUrl) {
      location.href = me.logoutUrl;
      return;
    }
    setMe(null);
    load();
  };

  /** Portal mode: drop the admin session, the portal account takes over again. */
  const backToAccount = async () => {
    closeSocket();
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  };

  const nav: [string, string][] = me.role === 'admin' ? [...NAV.slice(0, -1), ['/trainer', 'AI Trainer'], NAV.at(-1)!] : NAV;
  const table = match('/table/:id', path);
  const gameSetup = match('/games/:id', path);
  const rulesPage = match('/rules/:ruleset', path) as { ruleset: 'srd51' | 'srd52' } | null;
  const charView = match('/characters/:id', path);
  const charEdit = match('/characters/:id/edit', path);

  return (
    <MeContext.Provider value={me}>
      <div className={`mx-auto ${table ? 'max-w-none' : 'dm-page max-w-7xl p-3 sm:p-4'}`}>
        {!table && (
          <header className="mb-4 flex flex-wrap items-center gap-2">
            <button onClick={() => navigate('/')} className="flex items-center gap-2">
              <img src="/icon.svg" className="h-8 w-8" alt="" />
              <span className="font-serif text-xl font-semibold tracking-wide text-indigo-100">DungeonMind</span>
            </button>
            <nav className="dm-topnav order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:ml-4 sm:w-auto">
              {nav.map(([to, label]) => (
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
            {me.authMode === 'portal' &&
              (me.adminSession ? (
                <button className="text-xs text-indigo-300 hover:underline" onClick={backToAccount}>
                  Admin · Back to my account
                </button>
              ) : (
                <button className="text-xs text-slate-500 hover:text-indigo-300 hover:underline" onClick={() => setAdminLogin(true)}>
                  Admin login
                </button>
              ))}
            <button className="btn-ghost" onClick={logout}>
              Log out
            </button>
          </header>
        )}
        {path === '/' && <Lobby />}
        {path === '/settings' && <SettingsPage />}
        {path === '/homebrew' && <HomebrewPage />}
        {path === '/guide' && <GuidePage />}
        {path === '/trainer' && me.role === 'admin' && <TrainerPage />}
        {rulesPage && (rulesPage.ruleset === 'srd51' || rulesPage.ruleset === 'srd52') && <RulesPage ruleset={rulesPage.ruleset} />}
        {table && <Table id={table.id} />}
        {path === '/adventures/new' && <NewAdventure />}
        {gameSetup && <GameSetup id={gameSetup.id} />}
        {path === '/characters' && <CharacterLibrary />}
        {path === '/characters/new' && <NewCharacter />}
        {charView && charView.id !== 'new' && <CharacterView id={charView.id} />}
        {charEdit && <CharacterView id={charEdit.id} edit />}
      </div>
      {!table && isNative() && (
        <nav className="dm-bottomnav fixed inset-x-0 bottom-0 z-30 flex border-t border-[#30363d] bg-[#161b22]">
          {nav.map(([to, label]) => (
            <button key={to} onClick={() => navigate(to)} className={`flex-1 py-3 text-xs ${(to === '/' ? path === '/' : path.startsWith(to)) ? 'text-indigo-300' : 'text-slate-400'}`}>
              {label}
            </button>
          ))}
        </nav>
      )}
      {adminLogin && (
        <Modal title="Admin login" onClose={() => setAdminLogin(false)}>
          <AdminLoginForm onDone={() => location.reload()} />
        </Modal>
      )}
      <Toasts />
    </MeContext.Provider>
  );
}
