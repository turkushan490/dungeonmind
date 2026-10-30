# DungeonMind Lab API (Bookkeeper, training records, the AI Trainer)

**Status:** the Bookkeeper API was built in DungeonMind M13; the AI Trainer endpoints and the training records in M9. Since M9 DungeonMind does the game side of training itself (see GUIDE.md §16 and "AI Trainer" below); HiveMind only trains.

DungeonMind → HiveMind is described in HIVEMIND_CHANGES.md. This file is the other direction: **HiveMind's Lab calls DungeonMind**.

## Auth

1. In DungeonMind, **Settings → API tokens → Create** (name it "HiveMind Lab"). The token (`dm_…`) is shown once and stored as a sha256 hash.
2. HiveMind keeps the DungeonMind URL and token in its Lab settings.
3. Every call sends `Authorization: Bearer dm_…`. The token acts as the user who made it.

Errors use the same pattern as HiveMind: `{ "error": "…" }` with 400 (bad body), 401 (no/bad token), 403 (not allowed), 404 (not found).

`GET /api/lab/bookkeeper` (no auth) lists the endpoints and error types, for a compatibility check.

## `POST /api/lab/bookkeeper/check`: judge one simulated turn

Runs a turn through the real Bookkeeper and returns the verdict plus the party after the turn. **Stateless:** nothing is stored; the Lab keeps the party between turns by sending back `party` from the previous answer.

Request:

```json
{
  "ruleset": "srd51",
  "party": [
    { "name": "Esva", "class": "cleric", "level": 2, "hp": 10, "maxHp": 10,
      "abilities": { "str": 13, "dex": 10, "con": 14, "int": 8, "wis": 16, "cha": 12 },
      "counters": [ { "name": "Channel Divinity", "current": 0, "max": 1, "recharge": "short" },
                    { "name": "Spell slot L1", "current": 3, "max": 3, "recharge": "long" } ],
      "inventory": [ { "name": "Mace", "qty": 1, "equipped": true } ], "gold": 5, "xp": 0 }
  ],
  "npcs": [ { "name": "Goblin", "hp": 7, "maxHp": 7, "ac": 15, "status": "hostile" } ],
  "settings": { "xpMode": "xp", "approvalXp": 2000, "approvalGold": 500, "endLevel": 20 },
  "adjudication": { "rolls": [ … ], "resources": [ { "pc": "Esva", "name": "1st level spell slot", "amount": 1 } ] },
  "state": { "deltas": [ … ], "xp": [ … ], "npcs": [ … ], "choices": { … } }
}
```

- `party`: full DungeonMind characters (from `/character` below or a game), or minimal objects as above. Missing fields get defaults.
- `adjudication`: exactly the `rolls` JSON of the `dnd-adjudicate` canvas. DungeonMind recomputes every player bonus from the sheet, checks and spends resources, and **rolls the dice itself** (server RNG), including hit → damage, crits and save-for-half.
- `state`: exactly the `state` JSON of the `dnd-narrate` canvas. The Bookkeeper applies it with the same clamps as in a real game.
- `adjudication` and `state` are both optional; send one or both.

Response:

```json
{
  "ok": false,
  "errorTypes": ["invented-bonus", "unbacked-hp"],
  "errors": [
    { "type": "invented-bonus", "message": "Esva attacks Goblin (attack): the DM gave +9, the sheet says +5", "pc": "Esva" },
    { "type": "unbacked-hp", "message": "Bookkeeper held back Esva HP -4: no roll backs it. The host decides." }
  ],
  "changes": ["Esva: Spell slot L1 3/3 → 2/3", "Goblin: 7 → 0 HP (down)", "Esva +50 XP"],
  "approvals": [ { "kind": "delta", "name": "Esva", "amount": -4, "reason": "HP -4 without a dice roll" } ],
  "levelUps": [],
  "rolls": [ { "id": "r1", "actor": "Esva", "kind": "attack", "label": "…", "bonus": 5, "targetAc": 15, "result": { "total": 19, "success": true, "text": "…" } } ],
  "party": [ { "name": "Esva", "hp": 10, "counters": [ … ], … } ],
  "npcs": [ { "name": "Goblin", "hp": 0, "status": "dead" } ],
  "derived": { "Esva": { "ac": 10, "spellDc": 13, "spellAttack": 5, … } }
}
```

### Error types (for the Lab's scoreboard)

| type | the DM… |
|---|---|
| `refused-resource` | spent a resource the character doesn't have left (e.g. Channel Divinity at 0/1) or doesn't have at all |
| `invented-bonus` | gave a player character a roll bonus that isn't the sheet's |
| `bad-dice` | wrote damage/heal dice that aren't valid |
| `unbacked-hp` | changed HP without a dice roll behind it |
| `hp-mismatch` | wrote a different HP change than the dice gave |
| `overspend` | spent more of a counter than is left |
| `unknown-resource` | named a counter the character doesn't have |
| `unknown-character` | changed or gave choices to someone who isn't in the party |
| `gold` | spent gold the character doesn't have (or a gain above the approval threshold) |
| `missing-item` | removed an item that isn't in the inventory |
| `condition` | used a condition that isn't an SRD condition (tracked anyway) |

Missing roll requests and story quality aren't the Bookkeeper's job: the Lab's LLM judge keeps those.

## `POST /api/lab/bookkeeper/rest`

`{ "ruleset": "srd52", "party": [ … ], "kind": "short" | "long", "hitDice": { "<character id>": 2 } }` → `{ "changes": [ … ], "party": [ … ] }`. Same rules as the table (2014: half hit dice back on a long rest, 2024: all).

## `POST /api/lab/bookkeeper/character`

A real, legal sheet for a fake player. Body: a DungeonMind character build (same as the builder; `abilityMethod` standard or pointbuy). → `{ "character": { … counters, hp … }, "derived": { … } }`, or 400 with `errors` when the build breaks a rule.

## Real games

Every DM call of every game is recorded, unless the host ticked **"Don't use this game for AI training"** (setting `noTraining`). Players accept *"Games you play here are used to train the AI Dungeon Master."* at the 18+ / sign-up gate (`POST /api/auth/register` and `POST /api/auth/adult` need `"training": true`; `GET /api/auth/me` has `trainingAccepted`).

One record per AI block (`lab_records`): `canvas`, `node`, `messages` (the exact chat messages the block sent, from HiveMind's `GET /api/runs/:id?inputs=1` when it has `nodeInputs`; else a system line plus the question and vars), `output`, `label` (`good` | `bad` | `pending` | `accepted` | `rejected`), `source` (`game` | `sim` | `eval`), `corrected` (the judge's or the admin's correction).

Labels: **bad** when the Bookkeeper refused or noted something that turn, a reroll vote passed, or a player gave the narration a 👎 (`POST /api/games/:id/log/:logId/vote {up: true|false|null}`, one vote per player; `GET /api/games/:id/votes`). **good** when none of that, once the next turn has been told.

- `GET /api/lab/games` → the token owner's games used for training: `[{ id, name, ruleset, records }]`.
- `GET /api/lab/games/:id/turns.jsonl` (host only) → one line per record in chat SFT format:

```json
{"messages":[{"role":"system","content":"…"},{"role":"user","content":"…"},{"role":"assistant","content":"…"}],"meta":{"gameId":"…","turn":4,"canvas":"dnd-narrate","node":"state","label":"bad","bookkeeper":["Bookkeeper held back Turks HP -3: …"],"ok":false}}
```

The assistant message is the correction when there is one.

## AI Trainer (admin, M9)

All routes need an admin (session or `dm_` token). HiveMind features are detected through its `GET /api/health`; a missing one answers 409 `HiveMind needs updating (<feature>)` or shows as `false` in `features`.

| What | Method + path |
|---|---|
| Status: DM model, last result, next run, dataset, window, features | `GET /api/trainer/status` |
| Settings `{nightly, base, callbackUrl, judgeSample}` (reinstalls `dnd-nightly`) | `PUT /api/trainer/settings` |
| Train now (push + train + eval + decision) | `POST /api/trainer/train-now` → 202 `{jobId}` |
| The nightly result from HiveMind's HTTP block | `POST /api/trainer/candidate` |
| Scenarios | `GET/POST /api/trainer/scenarios`, `PUT/DELETE /api/trainer/scenarios/:id`, `POST …/bulk {text}`, `POST …/ai {theme, count}` (202), `POST …/from-game {gameId}`, `GET /api/trainer/games` |
| Simulations | `GET/POST /api/trainer/sims {models, games, turns, scenarioIds}`, `GET/DELETE /api/trainer/sims/:id`, `POST /api/trainer/sims/:id/stop` |
| Review | `GET /api/trainer/records?label=&source=&limit=&offset=`, `PUT /api/trainer/records/:id {action: accept\|edit\|reject, corrected?}`, `DELETE /api/trainer/records/:id` |
| Reports | `GET/POST /api/trainer/reports {simIds}`, `GET/DELETE /api/trainer/reports/:id`, `GET /api/trainer/reports/:id/download` (.md) |
| DM model picker | `GET /api/trainer/dm-models` (apply with `POST /api/hivemind/dm-model`) |
| Watch the AI backlog | `GET /api/trainer/live`, `GET /api/trainer/live/:stream` (live: Socket.IO `trainer:live`, admins only) |

**The candidate.** HiveMind's workflow `dnd-nightly` (a Train block on dataset "DungeonMind DM" with `minNewExamples: 100`, `nightly: true`, waiting until done, then an HTTP block) posts the Train block's output to `/api/trainer/candidate` with `Authorization: Bearer dm_…` (a token DungeonMind creates for this):

```json
{ "status": "done", "model": "dungeonmind-dm", "jobId": "…", "examples": 140 }
```

DungeonMind answers 202 at once, then plays the eval simulation (fixed scenarios and seeds, 2 games × 10 turns) with the candidate and with the current DM model (HiveMind `models` run override) and promotes the candidate only if it makes fewer errors per 100 turns AND its JSON valid % is not lower. `status: "skipped"` (too few new examples) is saved as a result line.

**What DungeonMind calls in HiveMind (M9):** `POST /api/runs {…, models}`, `GET /api/runs/:id?inputs=1`, `GET/POST /api/datasets`, `POST /api/datasets/:id/items {items: [{messages, meta}]}`, `POST /api/lab/train {base, name, providerId, datasetId, nightly, allowSmall}`, `GET /api/lab/train/:id`, `GET /api/lab/train/:id/events` (SSE), `GET /api/lab/window`, `PUT/GET /api/workflows/dnd-nightly/schedule {time: "03:00", days, enabled}`, `PUT /api/canvases/dnd-nightly`.

## The fine-tuned model back in DungeonMind

**AI Trainer → DM model** (also in Settings → HiveMind): pick from trained `dungeonmind-*` models, the curated list and models that passed the simulator; models not in Ollama yet are pulled. DungeonMind asks HiveMind to pull it (`POST /api/ollama/:providerId/pull`), sets it as the story and JSON model, and reinstalls the canvases (models picked by hand in HiveMind are kept). API: `POST /api/hivemind/dm-model { providerId, model, pull, roles? }` (admin).

## Try it

```bash
D=http://localhost:4830; T="Authorization: Bearer dm_xxx"
curl -s $D/api/lab/bookkeeper
curl -s -X POST $D/api/lab/bookkeeper/check -H "$T" -H 'content-type: application/json' -d '{"ruleset":"srd51","party":[{"name":"Esva","class":"cleric","level":2,"hp":10,"maxHp":10,"counters":[{"name":"Channel Divinity","current":0,"max":1}]}],"adjudication":{"rolls":[],"resources":[{"pc":"Esva","name":"Channel Divinity","amount":1}]}}' | jq '.errors'
```
