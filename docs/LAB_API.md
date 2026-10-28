# DungeonMind Bookkeeper API (for HiveMind's Training Lab)

**Status:** built in DungeonMind M13. This is the contract HiveMind's Lab (docs/HIVEMIND_CHANGES.md, Part 2) codes against when it replaces its mini bookkeeper (`server/src/lab/state.ts`) with DungeonMind's real one, and when it imports real games.

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

## Real games (opt-in)

A host can tick **"Share this game's DM turns with the Lab"** in the game's settings. From then on every DM call of that game is recorded (canvas, question, vars, outputs).

- `GET /api/lab/games` → the token owner's opted-in games: `[{ id, name, ruleset, records }]`.
- `GET /api/lab/games/:id/turns.jsonl` (host only) → one line per DM call in chat SFT format:

```json
{"messages":[{"role":"system","content":"DungeonMind canvas dnd-narrate (srd51). Mode: turn."},{"role":"user","content":"Turks (turks): I swing at the hag\n\n## campaign\n…"},{"role":"assistant","content":"## narration\n…\n\n## state\n{…}"}],"meta":{"gameId":"…","turn":4,"canvas":"dnd-narrate","bookkeeper":["Bookkeeper held back Turks HP -3: …"],"ok":false}}
```

`meta.bookkeeper` lists what the Bookkeeper corrected or held back in that turn; `ok` is true when it had nothing to say. That makes good labels for the review queue.

## The fine-tuned model back in DungeonMind

**Settings → HiveMind → Fine-tuned DM model:** pick the Ollama provider and the model (e.g. `hf.co/turkushan490/dungeonmind-dm-8b-gguf:Q4_K_M`), **Pull and use**. DungeonMind asks HiveMind to pull it (`POST /api/ollama/:providerId/pull`), sets it as the story and JSON model, and reinstalls the canvases (models picked by hand in HiveMind are kept). API: `POST /api/hivemind/dm-model { providerId, model, pull, roles? }` (admin).

## Try it

```bash
D=http://localhost:4830; T="Authorization: Bearer dm_xxx"
curl -s $D/api/lab/bookkeeper
curl -s -X POST $D/api/lab/bookkeeper/check -H "$T" -H 'content-type: application/json' -d '{"ruleset":"srd51","party":[{"name":"Esva","class":"cleric","level":2,"hp":10,"maxHp":10,"counters":[{"name":"Channel Divinity","current":0,"max":1}]}],"adjudication":{"rolls":[],"resources":[{"pc":"Esva","name":"Channel Divinity","amount":1}]}}' | jq '.errors'
```
