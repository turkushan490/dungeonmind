// Types shared by the server, the web UI and the Android app.

export type Role = 'admin' | 'user';
export type AuthMode = 'login' | 'portal';

export interface Me {
  id: string;
  username: string;
  role: Role;
  /** Answered the 18+ question. */
  adult: boolean;
  /** Accepted "Games you play here are used to train the AI Dungeon Master." */
  trainingAccepted: boolean;
  authMode: AuthMode;
  /** Portal mode: logged in through "Admin login" (wins over the portal until dropped). */
  adminSession?: boolean;
  /** Portal mode: the portal's logout page, from its X-Auth-Logout header. */
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
export * from './character';
export * from './game';
