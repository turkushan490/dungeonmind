import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';

const SECTIONS: { id: string; title: string; img?: string; body: React.ReactNode }[] = [
  {
    id: 'start',
    title: 'Getting started',
    body: (
      <>
        <p>DungeonMind is a table for Dungeons &amp; Dragons 5e where an AI is the Dungeon Master. It tells the story, plays the monsters and gives everyone choices. The server keeps every number honest: dice, hit points, spell slots, uses of every feature, XP.</p>
        <ol className="list-decimal pl-5">
          <li>Make a character in <b>Characters</b> (step by step, let the AI build one, or import one).</li>
          <li>Start an adventure from the <b>Lobby</b>, or accept an invite.</li>
          <li>Play: pick one of four choices or write your own, roll when asked, and listen to the narrator.</li>
        </ol>
        <p>New here? Play the <b>tutorial</b> first: a short scripted adventure that shows every part of the table in five minutes, no AI needed.</p>
      </>
    ),
  },
  {
    id: 'characters',
    title: 'Characters',
    img: '/guide/builder.jpg',
    body: (
      <>
        <p>Your characters live in your <b>library</b>. The builder goes step by step: ruleset (5e 2014 or 2024), species, class, background, ability scores (standard array, point buy, or 4d6 drop-lowest rolled by the server), skills, spells, equipment and story. Everything is checked live on the right, with your hit points, AC and resources.</p>
        <p>When you join a game, a <b>copy</b> of the character goes to the table at the game's start level. Portraits: make four with the AI, or upload your own.</p>
      </>
    ),
  },
  {
    id: 'adventure',
    title: 'Starting an adventure',
    img: '/guide/setup.jpg',
    body: (
      <p>
        The host picks the ruleset, the start and end level, how many players, the reroll budget and whether others may watch. Write what you want (a setting, a mood), pick one of the DM's four pitches or write your own, and answer the setup questions the DM made for that adventure. Invite players by name; when everyone has brought a character, begin.
      </p>
    ),
  },
  {
    id: 'table',
    title: 'The table',
    img: '/guide/table.jpg',
    body: (
      <>
        <p>
          <b>Left:</b> your sheet (tabs for the rest of the party). <b>Middle:</b> the scene picture, the initiative order, the zone board with ranges, and the dice. <b>Right:</b> the story, always readable from the start, with your choices at the bottom. On a phone these are three tabs you can swipe.
        </p>
        <p>The DM always waits for everyone. In a fight, actions happen in initiative order. If you're away, the host can skip you: your character stays quietly with the group.</p>
      </>
    ),
  },
  {
    id: 'dice',
    title: 'Dice and “I roll myself”',
    img: '/guide/dice.jpg',
    body: (
      <>
        <p>When your action needs a roll, it appears in the dice tray with everything already worked out: your bonus from the sheet, advantage or disadvantage, the target's AC or the DC.</p>
        <p>
          Press <b>🎲 Roll</b> and the server rolls. Or press <b>I roll myself</b>, roll your real dice, and type in what each die shows. The server checks every value (a d6 shows 1 to 6) and marks the roll ✋ in the story. Damage is only rolled after a hit; a natural 20 doubles the damage dice.
        </p>
      </>
    ),
  },
  {
    id: 'resources',
    title: 'Resources, rests and levels',
    body: (
      <>
        <p>
          Every limited thing is a counter with pips: spell slots, Channel Divinity, Rage, Bardic Inspiration, Ki, hit dice, even arrows. When you use one, the server spends it (<i>Channel Divinity 1/1 → 0/1</i>). If it's used up, the DM tells you and you pick something else; nothing is lost.
        </p>
        <p>The host gives short rests (spend hit dice to heal) and long rests (everything back). When you have the XP for the next level, a gold <b>Level up</b> button appears on your sheet.</p>
      </>
    ),
  },
  {
    id: 'ask',
    title: 'Ask the DM, rerolls, the campaign file',
    body: (
      <>
        <p>
          <b>Ask the DM</b> (under the choices): a rules question or "what does my character know about…". It never moves the story or holds up the turn.
        </p>
        <p>
          <b>Reroll</b> (top bar): don't like how the DM told it? Ask for a reroll. If most players agree, the DM tells that moment again with the same dice. The group has a limited number.
        </p>
        <p>
          <b>Campaign</b> (top bar): the living campaign file the DM keeps: story so far, NPCs, places, quests, loot and rulings. Everyone can read it; the host can edit it, and download the whole game as a save file.
        </p>
      </>
    ),
  },
  {
    id: 'voice',
    title: 'The narrator voice',
    img: '/guide/mobile.jpg',
    body: (
      <p>
        Press ▶ next to any narration to hear it, or turn on auto-read in <b>Settings → Narrator voice</b>. Pick your narrator, speed and volume; NPCs get their own voices, monsters sound like monsters. The spoken word lights up as it's read. Select any text and press <b>Read this aloud</b>. Stop and Skip are always at the bottom left.
      </p>
    ),
  },
  {
    id: 'spectate',
    title: 'Watching games',
    body: <p>Public games that are running show up under <b>Spectate</b> in the lobby. Spectators see the story, the sheets and the board and can listen to the narrator, but can't act.</p>,
  },
];

export function GuidePage() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <nav className="card h-fit space-y-1 text-sm lg:sticky lg:top-4">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="block rounded px-2 py-1 text-slate-300 hover:bg-[#21262d] hover:text-white">
            {s.title}
          </a>
        ))}
        <div className="rune-rule my-2" />
        <button className="btn w-full" disabled={busy} onClick={async () => (setBusy(true), navigate(`/table/${(await api<{ id: string }>('/api/tutorial', { body: {} }).finally(() => setBusy(false))).id}`))}>
          Play the tutorial
        </button>
        <button className="btn-ghost w-full" onClick={() => navigate('/rules/srd51')}>
          Rules: 5e 2014
        </button>
        <button className="btn-ghost w-full" onClick={() => navigate('/rules/srd52')}>
          Rules: 5e 2024
        </button>
      </nav>
      <div className="space-y-4">
        {SECTIONS.map((s) => (
          <section key={s.id} id={s.id} className="card readable space-y-2 text-sm leading-relaxed text-slate-300">
            <h2 className="rune-title">{s.title}</h2>
            <div className="space-y-2">{s.body}</div>
            {s.img && <img src={s.img} alt={s.title} loading="lazy" className={`rounded-lg border border-[#30363d] ${s.img.includes('mobile') ? 'max-w-[260px]' : 'w-full'}`} />}
          </section>
        ))}
        <p className="text-xs text-slate-500">
          Rules content from the SRD 5.1 and 5.2 (CC-BY-4.0, Wizards of the Coast). Setting up a server? See docs/GUIDE.md in the repository.
        </p>
      </div>
    </div>
  );
}
