# DungeonMind guide

This is the setup and admin guide. The player guide lives inside the app (**Guide** tab).

## 1. Install

### Unraid (Community Apps)
1. Search for **DungeonMind** in Apps, or add the template URL `https://raw.githubusercontent.com/turkushan490/dungeonmind/main/templates/dungeonmind.xml`.
2. Set **Data** (default `/mnt/user/appdata/dungeonmind`), **HiveMind URL** and **HiveMind token**.
3. Pick the **Auth mode** (see below) and start the container.

### Plain Docker
See the README quick start. Everything lives in `/data`.

## 2. Accounts (auth modes)

- **`AUTH_MODE=builtin`** (default): username + password accounts inside DungeonMind. Passwords are hashed with argon2id (scrypt on Node < 24.7). The **first account becomes the admin**. The admin can close registration in Settings → Users.
- **`AUTH_MODE=header`**: a forward-auth proxy logs people in and passes `X-Auth-User` and `X-Auth-Email` upstream. DungeonMind creates the account on the first visit (the first one is the admin). Set `AUTH_HEADER_TRUSTED_IPS` to your proxy's IP so nobody can fake the headers by reaching the port directly. In Nginx Proxy Manager, pass the headers from the auth subrequest:
  ```nginx
  auth_request_set $auth_user $upstream_http_x_auth_user;
  auth_request_set $auth_email $upstream_http_x_auth_email;
  proxy_set_header X-Auth-User $auth_user;
  proxy_set_header X-Auth-Email $auth_email;
  ```
- **18+:** every account answers the age question once (in the registration form, or on the first visit in header mode). Nothing else works until it's answered.

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
