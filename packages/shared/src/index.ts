// Types shared by the server, the web UI and the Android app.

export type Role = 'admin' | 'user';
export type AuthMode = 'builtin' | 'header';

export interface Me {
  id: string;
  username: string;
  role: Role;
  /** Answered the 18+ question. */
  adult: boolean;
  authMode: AuthMode;
  /** Header mode: the proxy's logout page. */
  logoutUrl?: string;
  prefs: Record<string, unknown>;
}

export interface PresenceUser {
  id: string;
  username: string;
  /** "lobby", "game:<id>", "builder", … */
  where: string;
}
export * from './rules';
