# DungeonMind guide

This is the setup and admin guide. The player guide lives inside the app (**Guide** tab, with screenshots), together with per-ruleset **Rules** pages and a scripted **tutorial** adventure that needs no AI (Lobby → Play the tutorial).

**Contents:** 1 Install · 2 Accounts · 3 Backups · 4 Connect HiveMind · 5 Rules data · 6 Characters · 7 Adventures · 8 Playing · 9 Turn loop & Bookkeeper · 10 Voices · 11 Images · 12 Animations · 13 Homebrew · 14 Phones · 15 Android · 16 HiveMind Lab

## 1. Install

### Unraid (Community Apps)
1. Search for **DungeonMind** in Apps, or add the template URL `https://raw.githubusercontent.com/turkushan490/dungeonmind/main/templates/dungeonmind.xml`.
2. Set **Data** (default `/mnt/user/appdata/dungeonmind`), **HiveMind URL** and **HiveMind token**.
3. Pick the **Auth mode** (see below), set **Admin username** and **Admin password**, and start the container.

### Plain Docker
See the README quick start. Everything lives in `/data`.

### Behind Nginx Proxy Manager (HTTPS)
Add a proxy host for `dm.example.com` → `http://<unraid-ip>:4830` with **Websockets Support** on (the table uses Socket.IO), and request a certificate. Cookies get the Secure flag by themselves when the proxy says the request came in over HTTPS (`X-Forwarded-Proto`). For `AUTH_MODE=portal` put the forward-auth snippet from section 2 in the host's Advanced tab.

### First start
1. Open the WebUI and log in with the admin account (`ADMIN_USERNAME` / `ADMIN_PASSWORD`). In portal mode, use the **Admin login** link in the top bar.
2. **Settings → HiveMind:** URL + token, models, *Install / update canvases*, *Load SRD rules into HiveMind memory* (section 4).
3. **Settings → Narrator voice:** pick the default engine and narrator (section 10). The first narration takes a moment while the voice model loads.
4. Try the tutorial, then start a real adventure.

### CPU only
The image needs no GPU. The narrator (Kokoro) runs on the CPU; all LLM and image work happens in HiveMind (which can use cloud models if there's no GPU anywhere).

## 2. Accounts (auth modes)

- **Admin account (both modes):** `ADMIN_USERNAME` + `ADMIN_PASSWORD` in Docker. On every start DungeonMind creates that account if it is missing; if it exists it is made admin and gets that password. A weak password only logs a warning. Nobody becomes admin just by being first. More admins: Settings → Users.
- **Passwords:** at least 5 characters, with 1 capital and 1 symbol. Hashed with argon2id (scrypt on Node < 24.7).
- **`AUTH_MODE=login`** (default): DungeonMind login page (username + password, friends register themselves). The admin can close registration in Settings → Users. (`builtin` is the old name and still works.)
- **`AUTH_MODE=portal`**: auth portal (e.g. turkushan-auth) + admin login (people come in through the portal; the login page is only for the Docker admin). The portal logs people in and passes `X-Auth-User` and `X-Auth-Email`; DungeonMind creates the account on the first visit as a plain user. (`header` is the old name and still works.) Only expose DungeonMind through the proxy: the headers are always accepted.
  - **Admin login:** a small link in the top bar opens a username/password dialog for the Docker admin. While that session exists it wins over the portal; the bar shows **Admin · Back to my account**, which drops it.
  - **Log out:** if the portal sends `X-Auth-Logout` (its logout page), Log out goes there; otherwise it only drops the DungeonMind session.
  - **Optional portal info:** `X-Auth-Groups` (comma separated), `X-Auth-Admin` (`true`/`false`) and `X-Auth-Discord-Roles` are stored on the user and shown in Settings → Users. Under **Admin groups** (Settings → Users) list the portal groups whose members get the admin role; `X-Auth-Admin: true` does the same. Without these headers nothing changes.
  - In Nginx Proxy Manager, pass the headers from the auth subrequest (the full list for turkushan-auth is in [TURKUSHAN_AUTH_HEADERS.md](TURKUSHAN_AUTH_HEADERS.md)):
  ```nginx
  auth_request_set $auth_user $upstream_http_x_auth_user;
  auth_request_set $auth_email $upstream_http_x_auth_email;
  proxy_set_header X-Auth-User $auth_user;
  proxy_set_header X-Auth-Email $auth_email;
  ```
- **18+:** every account answers the age question once (in the registration form, or on the first visit in portal mode and for the Docker admin). Nothing else works until it's answered.

## 3. Backups

Back up the **Data** folder (`/mnt/user/appdata/dungeonmind`): `dungeonmind.db` (+ `-wal`/`-shm`), `secret.key`, `images/`, `audio/` and `models/`. Stop the container (or use the Unraid Appdata Backup plugin) for a consistent SQLite copy. Audio and models can be regenerated; the database and `secret.key` cannot.

## 4. Connect HiveMind

DungeonMind does no AI itself. Everything goes through your [HiveMind](https://github.com/turkushan490/hivemind), server to server.

1. HiveMind must have the DungeonMind API changes (see [HIVEMIND_CHANGES.md](HIVEMIND_CHANGES.md)). Settings → HiveMind shows a compatibility check; games refuse to start while required features (`vars`, `jsonMode`, `memoryKeyTemplate`, `nodeOutputs`, `memorySearch`, `memoryImport`) are missing.
2. In HiveMind, create an API token (Settings → API tokens) as a **member** account (viewers can't install canvases).
3. In DungeonMind → **Settings → HiveMind**, enter the URL (LAN IP, e.g. `http://192.168.1.10:4820`) and the token. The token is stored encrypted.
4. Pick the **models**: a story model for narration and Ask the DM, a JSON model for rules/state/chronicle/sheets, and an image model (ComfyUI) for portraits and scenes.
5. Click **Install / update canvases**. It writes these canvases into your HiveMind (fixed ids, so a reinstall overwrites them but keeps models you picked in HiveMind):

| Canvas | Does |
|---|---|
| `dnd-setup` | adventure pitches + the dynamic setup form |
| `dnd-adjudicate` | which rolls and resources the actions need (never rolls) |
| `dnd-narrate` | narration with the real dice results, then the state JSON, then memory save |
| `dnd-chronicle` | campaign.md section patches after every turn |
| `dnd-ask` | out-of-turn "Ask the DM" answers |
| `dnd-sheet` | a full character sheet from a description |
| `dnd-portrait` | 4 portrait options (image batch) |
| `dnd-scene` | one scene illustration |

   You can also download each canvas JSON (click its name) and import it in HiveMind by hand. The source is in [`hivemind/`](../hivemind).
6. Click **Load SRD rules into HiveMind memory**. It imports every rule, spell, condition, feature, item and monster as one entry under the memory keys `rules:srd51` and `rules:srd52` (about 2 300 and 1 800 entries).

### Model recommendations

| Hardware | Story model | JSON model | Context (`numCtx`) |
|---|---|---|---|
| CPU only | a 3–4B instruct model, or a cloud model through HiveMind | same | 8K |
| 8 GB VRAM | 7–8B (e.g. Qwen 8B) | same | 16K |
| 12–16 GB VRAM | 12–14B (e.g. Gemma 12B, Qwen 14B) | gpt-oss 20B | 32K |
| 24 GB VRAM | Cydonia / Mistral Small 24B | gpt-oss 20B | 32K |

More context means more VRAM: roughly +1 GB per 8K tokens for an 8B model, +2 GB for 24B. The narration node asks for 32K (`numCtx: 32768`); lower it in HiveMind if your GPU can't hold it.

## 5. Rules data (SRD 5.1 and 5.2)

The rules live in `server/data/srd51/rules.json` and `server/data/srd52/rules.json`, imported from the [5e-bits 5e-database](https://github.com/5e-bits/5e-database) (the data behind the 5e-srd-api) with `scripts/import-srd.mjs`. Licensed CC-BY-4.0 (Wizards of the Coast); attribution is in the app footer and the README.

**2024 completeness check (M2):** the 5e-database has every 2024 class (with levels and slots), species, background, feat, spell, item, monster and condition, but **no rule sections** (combat, resting, concentration…). Those 29 sections are filled from the SRD 5.2 text in `scripts/srd52-gaps.json`. The 2024 data also has fewer feature descriptions (232 vs 407), which the builder doesn't need.

## 6. Characters

Every player has a **character library** (Characters tab). Characters are copied into a game when they join it (same ruleset), so the library copy stays clean.

- **Builder:** step by step: ruleset, species, class (+ subclass at the right level), background, ability scores (standard array, 27-point buy, or 4d6-drop-lowest rolled **by the server**), skills, spells, equipment and story. The server checks every rule live (skill lists and counts, point-buy cost, background/species bonuses, ASIs, spell lists, cantrip/known/prepared counts, slot levels) and shows the derived sheet (HP, AC, saves, spell DC, resource counters).
- **AI builds the sheet:** describe the character; HiveMind's `dnd-sheet` canvas returns a sheet, DungeonMind validates it and gives the AI one chance to fix illegal parts, then it opens in the builder as a draft.
- **Import:** a DungeonMind export (`.dungeonmind.json`), any JSON sheet with common field names (race/species, class, stats/abilities, skills, spells…), or pasted text (read by the AI).

## 7. Adventures

Every logged-in user can create adventures (**Lobby → New adventure**). A player only gets into games they're **invited** to.

1. **Ruleset:** 5e 2014 (SRD 5.1) or 5e 2024 (SRD 5.2).
2. **Table rules:** start and end level (e.g. 1→14), max players, whether a player may run several characters, the group's reroll budget, XP or milestones, and whether spectators may watch (public/private, changeable any time).
3. **The idea:** write your wishes; the DM (`dnd-setup`) suggests 4 pitches, or you write your own.
4. **The setup form:** for the chosen pitch the DM builds a form specific to that adventure (dropdowns, sliders, text). Your answers go into the campaign file.
5. **Invite** players by username. They see the invite in their lobby (live), accept, and bring a character from their library (same ruleset, at the start level; it's re-checked for legality and copied into the game).
6. **Spectators:** running public games show up in everyone's **Spectate** list (read only).

## 8. Playing

- **The table:** your sheet on the left (tabs for the rest of the party), the zone board in the middle (scene image, positions and ranges, dice tray), the story log on the right with the choice boxes at the bottom. On a phone the three panes are swipeable tabs.
- **Turns:** every seated player picks one of 4 choices or writes their own ("Other"). The DM always waits for everyone; there's no timer. In combat the actions go in initiative order.
- **Ask the DM:** an out-of-turn question (rules, what your character knows). It never moves the story and never blocks the turn.
- **Robustness:** a HiveMind crash, timeout or invalid output is retried automatically (3 tries, no reroll used). If it still fails, the turn stays exactly as it was and anyone at the table can press **Retry**. A server restart mid-turn does the same.
- **The DM queue:** DungeonMind keeps its own queue in front of HiveMind; at most *N* tables think at once (admin setting `maxThinking`, default 2). Waiting tables see "The DM is thinking… (#2 in queue)".
- **Absent players:** the host can **pause** or **end** the game, or **skip** an absent player: the character stays quietly with the group until the player is back.
- **Save / resume:** every turn is saved in SQLite. Games can be paused and resumed any time; **Campaign → Download save** gives the campaign file plus the whole story as Markdown.

### The campaign file (campaign.md)

Each game has a living `campaign.md` with fixed sections: How to run · Story so far · Current scene · Party status · NPCs · Locations · Quests and open threads · Loot and items · Rulings made · Timeline. The **Chronicler** (`dnd-chronicle`) updates it after every turn with section patches (it can't rewrite things away, and it can't touch the party table, which the server generates from the database). At a scene end it compresses "Story so far". Everyone in the game can read it; the host can edit it; every version is kept. Every DM prompt gets the full file, the rules found by memory search, and the last turns verbatim.

## 9. The turn loop and the Bookkeeper

Every turn runs on the server, step by step, and every step is in the story log:

1. **Collect** every active player's action (in initiative order during combat).
2. **Adjudicate** (`dnd-adjudicate`): which rolls the actions need (attack vs AC, save vs DC, checks, damage, healing) and which **resources** they spend. It never rolls.
3. **Check and spend.** A resource that isn't there (e.g. *Channel Divinity 0/1*, a spell slot level you don't have, the last arrow) refuses that action: the player sees why and picks again, nothing is spent. Otherwise the server spends it (`Channel Divinity 1/1 → 0/1`).
4. **Dice.** For player characters the server computes every modifier from the sheet (ability, proficiency, weapon, spell attack/DC, conditions that give advantage or disadvantage); the AI's numbers are only used for NPCs. Per roll the player picks **🎲 Roll** (server, crypto RNG) or **I roll myself**: they enter the face of each physical die, the server checks every value against the die (1–6 for a d6…) and marks the roll ✋ in the log. NPC rolls and rolls of away players are made by the server. Damage only rolls after a hit (doubled dice on a natural 20); "save for half" spells halve on a made save.
5. **Narrate** (`dnd-narrate`) with the real results, then the **state JSON** (deltas, XP, conditions, items, NPCs, combat, zones, choices).
6. **Bookkeeper** (every turn, every character):
   - HP comes from the dice: damage goes through temporary HP first, never below 0; at 0 the character falls unconscious (instant death on massive damage), damage at 0 is a death-save failure, healing never exceeds max and wakes the character. Concentrating characters roll the Constitution save automatically.
   - The AI's other deltas are clamped: counters never below 0 or above max, items must exist to be removed, gold can't go negative, conditions are tracked with durations. An HP change the dice don't back, gold above the host's threshold, or XP above the threshold goes to the **host for approval**. If the DM wrote a different HP number than the dice, the server's number wins and the host sees a Bookkeeper note.
   - Conditions tick down, per-turn counters recharge, and **XP is checked against the level table after every round**: at a threshold a level-up banner appears (capped at the game's end level).
7. **Chronicler** updates `campaign.md`; HiveMind saves the turn to campaign memory.

**Resources** are counters `{name, current, max, recharge}`: spell slots per level (warlock pact slots on a short rest), class features (Rage, Bardic Inspiration, Channel Divinity, Wild Shape, Second Wind, Action Surge, Ki/Focus, Lay on Hands, Sorcery Points, Arcane Recovery…), species traits (Relentless Endurance, Breath Weapon…), hit dice and ammunition. The sheet shows pips `●○ 1/2`.

**Rests** (host, outside combat): a short rest refills short-rest counters and lets each character spend hit dice (server-rolled + CON); a long rest refills everything, HP to max, hit dice back (SRD 5.1: half, SRD 5.2: all), exhaustion −1.

**Levels:** XP (or the host's **Milestone** button) unlocks the **level-up step** on the sheet: HP fixed, server-rolled or "I roll myself", plus new subclass/ASI/spells, checked like the builder.

**Initiative** is rolled by the server when the DM starts a fight (d20 + DEX for each character and enemy; ties: higher bonus, then players first). Each turn in combat is one round; dead or fled enemies leave the order and the fight ends when none are left.

**Zone board:** the DM places everyone in named zones with distances in feet; the server validates names and distances and shows ranges ("Range from Turks: The Bell-Hag melee · Esvahanna 15 ft").

**Rerolls:** any player can ask to have the last narration told again. A **majority** of the players (one vote each) must agree. The turn rolls back to just before the narration and the DM tells it again **with the same dice**. The host sets the budget at setup.

**Host override:** the host can set HP, temp HP, XP, gold, exhaustion, counters and conditions directly; every override is logged for everyone.

## 10. Narrator voices

- **Kokoro (default, built in):** Kokoro-82M runs inside the container on the CPU (`kokoro-js`, ONNX, no Python). The image build bakes the model in (`/app/models`); if that wasn't possible it downloads once to `/data/models` on first use. 28 English voices (American and British).
- **Chatterbox (optional):** the `ghcr.io/turkushan490/dungeonmind:full` image adds Python, CPU torch and [Chatterbox](https://github.com/resemble-ai/chatterbox) (MIT) as a sidecar on `127.0.0.1:4831`. Pick it in **Settings → Narrator voice → Engine**. It clones a short reference clip per voice (DungeonMind records these with Kokoro into `/data/voices/<voice>.wav`; you can drop in your own). It's much slower on a CPU; with an NVIDIA GPU run the container with `--gpus all`. The `:full` image is built on version tags or by hand (Actions → build → Run workflow).
- **Listening test:** Settings → Narrator voice has a test box. Try both engines on real story text; the admin picks the default engine and narrator voice there.
- **Voice casting:** the narrator speaks in each listener's own chosen voice. The State LLM tags who speaks; quoted lines go to that NPC, who gets a fitting voice from the library (gender, age, monster) the first time and keeps it for the whole game. Monsters, giants, ghosts and tiny creatures get **effects** (pitch, distortion, reverb) with ffmpeg.
- **Per user:** voice, speed, volume, auto-read of new narration, and highlighting of the spoken word. Select any text in the story and press **Read this aloud**. Stop and Skip are always visible while something plays.
- **Audio cache:** each narration is spoken once per voice and stored (`/data/audio`), so every listener with that voice plays the same file. New narration is pre-spoken in the default voice right after the turn. Audio unplayed for the retention period (default 14 days) is deleted.

## 11. Portraits and scene images

- **Portraits:** on a character's page, **Make 4 portraits** runs the `dnd-portrait` canvas (an LLM writes the image prompt from the appearance, then one image block makes 4 variants with `batch: 4`). Pick one, **Regenerate**, or **Upload my own** (PNG/JPEG/WebP/GIF up to 8 MB; the server checks the bytes, not the file name). The portrait also updates that character's copies in games.
- **Scene images:** when the State LLM describes a new scene (`image` in the state JSON), DungeonMind runs `dnd-scene` in the background and shows the picture above the zone board and in the story. Hosts can turn this off per game ("Illustrate new scenes").
- Every image from HiveMind is **copied into DungeonMind's appdata** (`/data/images`), so games keep their pictures even if HiveMind's files are cleaned up.
- Images need an image model (ComfyUI through HiveMind) on those canvases; without one, DungeonMind says so and the game goes on without pictures.

## 12. Animations

- **3D dice** with [`@3d-dice/dice-box`](https://github.com/3d-dice/dice-box) (MIT). Every roll at the table plays for everyone: a short physics tumble, then the **server's real faces** pop up (gold on a critical, red on a natural 1, ✋ when the player rolled their own dice). dice-box can't force results, so the tumble only sets the mood; the numbers are always the server's. The physics engine loads only on the first roll.
- **Ink text:** a new narration writes itself out word by word, and keeps pace with the narrator voice when it's playing.
- **Effects:** HP bars shake and flash red on damage and glow green on healing, spent spell-slot pips fade out, and a level-up bursts gold.
- Turn them off in **Settings → Reading → Animations**; the system "reduce motion" setting is respected too.

## 13. Homebrew

**Homebrew** (top menu) lets anyone add their own **spells, items, monsters, feats, conditions, rules, species and backgrounds** per ruleset. They get ids starting with `hb-` so they never overwrite SRD content, and they join the rules for that ruleset: the builder offers them (a homebrew spell is legal for the classes you list), the rules search finds them, and **Settings → HiveMind → Load SRD rules into HiveMind memory** sends them to the DM too (run it again after adding homebrew). The maker or an admin can edit, disable or delete an entry. Numbers are clamped (AC ≤ 30, spell level 0–9, …).

## 14. Phones

The whole app works on a phone: the table's three panes become swipeable tabs (Sheet · Board · Story), inputs don't zoom on iOS, the bottom respects the home-indicator area, and **Add to Home Screen** installs it like an app (web manifest). The Android app (below) wraps the same pages.

## 15. Android

The Android app is a Capacitor shell in [`android/`](../android) (see its README). GitHub Actions builds the APK on changes and attaches it to releases on `v*` tags. Install it, enter your server address once, and log in on your server's own login page (both auth modes). It shows the same app with a bottom tab bar; Settings → Change server switches servers. There are no push notifications; invites and notices appear in the app.

## 16. HiveMind Lab (training a faster DM)

HiveMind's Training Lab simulates games, scores models and fine-tunes a fast DM model. DungeonMind helps in three ways (details and JSON in [LAB_API.md](LAB_API.md)):

1. **The Bookkeeper as the judge:** the Lab sends each simulated turn (adjudication + state JSON) to `POST /api/lab/bookkeeper/check` with a DungeonMind API token (Settings → API tokens) and gets typed errors (resources used up, invented bonuses, HP without dice, …) and the party after the turn.
2. **Real games, opt-in:** hosts can tick "Share this game's DM turns with the Lab"; the Lab downloads them as chat JSONL with the Bookkeeper's notes as labels.
3. **The fine-tuned model as the default:** Settings → HiveMind → Fine-tuned DM model → **Pull and use**.
