import { api } from '../api';
import { Attribution, Landing } from './Login';

/** Header-mode users (and anyone who never answered) see this once. */
export function AgeGate({ onDone, logoutUrl }: { onDone: () => void; logoutUrl?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Landing />
      <div className="card w-full max-w-sm space-y-3">
        <h2 className="rune-title">Before you enter</h2>
        <p className="text-sm text-slate-300">DungeonMind tells dark, mature stories: violence, horror and death. It is for adults only.</p>
        <button className="btn w-full" onClick={() => api('/api/auth/adult', { body: { confirm: true } }).then(onDone)}>
          I am 18 or older
        </button>
        <button className="btn-ghost w-full" onClick={() => (location.href = logoutUrl || 'about:blank')}>
          I am not, leave
        </button>
      </div>
      <Attribution />
    </div>
  );
}
