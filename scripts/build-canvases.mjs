#!/usr/bin/env node
// Writes hivemind/*.canvas.json: the HiveMind canvases DungeonMind installs (PUT /api/canvases/<id>).
// Edit the prompts here, run `node scripts/build-canvases.mjs`, commit both. A test checks they stay in sync.
import { writeFileSync } from 'node:fs';

const NUMBERS = `THE NUMBERS ARE THE SERVER'S. Never invent dice results, hit points, spell slots, gold or XP totals. Use only the results and party state you are given. If something needs a roll that wasn't made, don't resolve it.`;
const TONE = `Tone: dark, mature, grounded fantasy. Vivid but concise. Second person for the party ("you"), third person for NPCs. Players may write with typos; understand what they mean. Everything you write is in English.`;

const node = (id, type, label, x, config = {}) => ({ id, type, label, position: { x, y: id.length * 20 }, config });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });
const canvas = (id, name, description, nodes, edges) => ({ id, name, description, shared: false, nodes, edges });

const PARTY_CONTEXT = `## Campaign file
{{vars.campaign}}

## Party state (authoritative)
{{vars.party}}

## Recent turns
{{vars.recent}}`;

const canvases = [
  canvas(
    'dnd-setup',
    'DungeonMind: adventure setup',
    'Pitches and a dynamic setup form for a new adventure (DungeonMind).',
    [
      node('in', 'input', 'input', 0),
      node('pitch', 'llm', 'pitch', 300, {
        json: true,
        numCtx: 16384,
        temperature: 0.9,
        jsonSchema: `stage "pitches": {"pitches":[{"title":string,"hook":string,"tone":string,"themes":[string]}]} (exactly 4)
stage "form": {"title":string,"summary":string,"fields":[{"id":string,"label":string,"type":"select"|"slider"|"text"|"multi","options"?:[string],"min"?:number,"max"?:number,"default":string|number|[string],"help"?:string}]} (5-9 fields)`,
        system: `You are the Dungeon Master preparing a new tabletop adventure for {{vars.ruleset}} (D&D 5e). ${TONE}
Reply with JSON only.`,
        prompt: `Stage: {{vars.stage}}
Start level {{vars.startLevel}}, end level {{vars.endLevel}}, up to {{vars.maxPlayers}} players.
Host's wishes: {{question}}
Chosen pitch (stage "form" only): {{vars.pitch}}

If the stage is "pitches": suggest 4 distinct adventure pitches that fit the wishes and the level range. Each has a title, a two-sentence hook, a tone and themes.
If the stage is "form": design a setup form for THIS adventure: the questions the host should answer before play (e.g. the villain's nature, how deadly, the starting location, a faction, how much horror). Use select/multi with 3-6 options, slider with min/max, or short text. Every field has a sensible default.`,
      }),
    ],
    [edge('in', 'pitch')],
  ),
  canvas(
    'dnd-adjudicate',
    'DungeonMind: adjudicate',
    'Which rolls and resources the players\' actions need (DungeonMind). Never rolls itself.',
    [
      node('in', 'input', 'input', 0),
      node('rules', 'memory', 'rules', 250, { mode: 'search', key: 'rules:{{vars.ruleset}}', query: '{{vars.actions}}', limit: 6 }),
      node('rolls', 'llm', 'rolls', 500, {
        json: true,
        numCtx: 16384,
        temperature: 0.2,
        jsonSchema: `{"rolls":[{"id":string,"actor":string,"kind":"attack"|"save"|"check"|"damage"|"heal","ability"?:"str"|"dex"|"con"|"int"|"wis"|"cha","skill"?:string,"dc"?:number,"target"?:string,"targetAc"?:number,"adv"?:"adv"|"dis"|"none","dice"?:string,"bonus"?:number,"damageType"?:string,"weapon"?:string,"spell"?:string,"onHit"?:string,"onFail"?:string,"half"?:boolean,"reason":string}],
"resources":[{"pc":string,"name":string,"amount":number}],
"refused":[{"pc":string,"reason":string}],
"notes"?:string}`,
        system: `You are the rules adjudicator of a D&D 5e game ({{vars.ruleset}}). You decide which dice must be rolled to resolve the players' declared actions, and which limited resources each action spends. ${NUMBERS}
Rules:
- One entry per roll. "actor" is the exact name of who rolls (a player character or an NPC/monster).
- Attacks: kind "attack" with "target" and "targetAc" (the NPC's AC from the party state/campaign; guess sensibly if unknown). Follow with a "damage" roll whose "onHit" is the attack's id.
- Saving throws forced by a PC's spell: kind "save", actor = the target, "ability", "spell", "dc" = the caster's spell save DC from the party state. Damage on a failed save: "onFail" = the save's id, with "half": true when a made save still takes half (e.g. Fireball).
- A creature at 0 HP makes no attacks. Monsters attack too: give their rolls with the stat block's bonus.
- Skill checks: kind "check" with "skill" (e.g. "stealth") or "ability", and a "dc".
- For player characters NEVER give "bonus": the server computes modifiers from the sheet. For NPCs give "bonus".
- "dice" for damage/heal like "2d6+3" or "8d6". Use the weapon or spell's real dice.
- "resources": every limited thing the action spends: "Spell slot L1".."Spell slot L9", class features ("Channel Divinity", "Rage", "Bardic Inspiration", "Ki", "Action Surge", "Second Wind", "Lay on Hands", "Sorcery Points", "Wild Shape"), racial traits, item charges, ammunition ("Arrows"). Cantrips spend nothing. Use the counter names from the party state when they exist.
- If an action is impossible by the rules (e.g. a spell the character doesn't have, a feature at 0 uses, an action already used), put it in "refused" with a short reason the player sees.
- Pure roleplay or movement without risk needs no roll. Reply with JSON only.`,
        prompt: `${PARTY_CONTEXT}

## Combat (initiative order, null when not in combat)
{{vars.combat}}

## Declared actions (in this order)
{{vars.actions}}

## Relevant rules
{{inputs}}`,
      }),
    ],
    [edge('in', 'rules'), edge('rules', 'rolls')],
  ),
  canvas(
    'dnd-narrate',
    'DungeonMind: narrate',
    'Narration with the real dice results, then the state JSON (DungeonMind).',
    [
      node('in', 'input', 'input', 0),
      node('memory', 'memory', 'campaign memory', 250, { mode: 'search', key: 'dnd:{{vars.tableId}}', query: '{{vars.actions}}', limit: 6 }),
      node('rules', 'memory', 'rules', 250, { mode: 'search', key: 'rules:{{vars.ruleset}}', query: '{{vars.actions}}', limit: 4 }),
      node('narration', 'llm', 'narration', 500, {
        numCtx: 32768,
        temperature: 0.85,
        system: `You are the Dungeon Master of an ongoing D&D 5e campaign ({{vars.ruleset}}). ${TONE}
${NUMBERS}
- Narrate what happens because of the players' actions, using exactly the dice results given (hits, misses, damage numbers, saves). You may mention numbers ("the blade bites for 7 damage") but never different ones.
- NPCs act and speak. Put spoken lines in quotes and name the speaker, e.g. The hag hisses, "Closer, little lamb."
- Keep it to 2-5 short paragraphs. End at a moment where the players must choose.
- Mode "opening": write the opening scene of the adventure from the campaign file and invite the players to introduce their characters.
- Never decide for the players what their characters say or feel.`,
        prompt: `Mode: {{vars.mode}}

${PARTY_CONTEXT}

## What the players declared
{{vars.actions}}

## Dice results (server-rolled, final)
{{vars.results}}

## Memory and rules
{{inputs}}`,
      }),
      node('state', 'llm', 'state', 750, {
        json: true,
        numCtx: 32768,
        temperature: 0.2,
        jsonSchema: `{"deltas":[{"pc":string,"hp"?:number,"tempHp"?:number,"gold"?:number,"counters"?:{[name:string]:number},"addItems"?:[string],"removeItems"?:[string],"addConditions"?:[{"name":string,"rounds"?:number,"source"?:string}],"removeConditions"?:[string],"concentration"?:string|null}],
"xp":[{"pc":string,"amount":number,"reason":string}],
"npcs":[{"name":string,"hp"?:number,"maxHp"?:number,"ac"?:number,"dex"?:number,"status"?:"hostile"|"neutral"|"friendly"|"dead"|"fled","voice"?:string}],
"combat":{"start"?:boolean,"end"?:boolean,"enemies"?:[string]}|null,
"zones":[{"name":string,"distances":{[otherZone:string]:number}}],
"positions":{[zone:string]:[string]},
"choices":{[pc:string]:[string,string,string,string]},
"speakers":[{"name":string,"kind":"narrator"|"npc"|"monster","gender"?:"male"|"female"|"neutral","age"?:"child"|"young"|"adult"|"old"}],
"image":string|null,
"sceneEnd":boolean,
"summary":string}`,
        system: `You turn the Dungeon Master's narration into the game state change, as JSON. ${NUMBERS}
- "deltas": only changes the narration and the dice results caused. "hp" must equal the damage (negative) or healing (positive) in the dice results; HP changes without a roll are held for the host. Spent items/ammo/gold. Conditions applied or ended ("rounds" = how long, omit for until removed). Do NOT include spell slots or features spent by the declared actions: the server already spent those.
- "xp": award XP for defeated foes, solved problems and milestones, only when earned in this turn.
- "npcs": every NPC/monster that matters now, with its current hp/maxHp/ac when known (use the SRD stat block values for monsters), status changes included.
- "combat": {"start":true,"enemies":[names]} when a fight begins, {"end":true} when it ends, else null.
- "zones" + "positions": the named areas of the current scene with distances in feet between them, and who stands where (every PC and NPC present).
- "choices": for EVERY player character exactly 4 short, distinct, actionable options that fit their class and situation (the player can always write their own).
- "speakers": who speaks in the narration, in order, starting with the narrator.
- "image": a one-sentence visual description of the scene for an illustration when the scene changes a lot, else null.
- "sceneEnd": true when this scene is over (a rest, a journey, a chapter end).
- "summary": one line of what happened.
Reply with JSON only.`,
        prompt: `## Party state (authoritative)
{{vars.party}}

## Dice results
{{vars.results}}

## Corrections to make (if any)
{{vars.fix}}

## The narration
{{inputs}}`,
      }),
      node('save', 'memory', 'save', 750, { mode: 'save', key: 'dnd:{{vars.tableId}}' }),
    ],
    [edge('in', 'memory'), edge('in', 'rules'), edge('memory', 'narration'), edge('rules', 'narration'), edge('narration', 'state'), edge('narration', 'save')],
  ),
  canvas(
    'dnd-chronicle',
    'DungeonMind: chronicler',
    'Keeps the campaign file up to date with section patches (DungeonMind).',
    [
      node('in', 'input', 'input', 0),
      node('patches', 'llm', 'patches', 300, {
        json: true,
        numCtx: 32768,
        temperature: 0.2,
        jsonSchema: `{"patches":[{"section":"How to run"|"Story so far"|"Current scene"|"NPCs"|"Locations"|"Quests and open threads"|"Loot and items"|"Rulings made"|"Timeline","op":"replace"|"append","text":string}]}`,
        system: `You are the Chronicler. You keep the campaign file (markdown) accurate so the Dungeon Master never forgets anything. Return only the sections that change, as patches.
- "append" adds lines to the end of a section; "replace" rewrites the whole section (use it for "Current scene", and for "Story so far" only in mode "summary").
- Keep entries short, factual, in English. NPCs: name, role, attitude, voice (if given), alive/dead. Quests: open/closed. Timeline: one line per turn.
- Never touch the party table: the server writes it.
- Mode "summary": compress "Story so far" into a tight chapter summary (max ~250 words) that keeps every important fact, name and open thread.
Reply with JSON only.`,
        prompt: `Mode: {{vars.mode}}

## Current campaign file
{{vars.campaign}}

## This turn
{{question}}

## State JSON of this turn
{{vars.state}}`,
      }),
    ],
    [edge('in', 'patches')],
  ),
  canvas(
    'dnd-ask',
    'DungeonMind: ask the DM',
    'Out-of-turn questions to the DM; never moves the story (DungeonMind).',
    [
      node('in', 'input', 'input', 0),
      node('rules', 'memory', 'rules', 250, { mode: 'search', key: 'rules:{{vars.ruleset}}', limit: 5 }),
      node('memory', 'memory', 'campaign memory', 250, { mode: 'search', key: 'dnd:{{vars.tableId}}', limit: 5 }),
      node('answer', 'llm', 'answer', 500, {
        numCtx: 32768,
        temperature: 0.4,
        system: `You are the Dungeon Master answering an out-of-turn question from {{vars.asker}}: a rules question, or what their character knows or notices. ${TONE}
- Answer briefly and accurately. Quote the rule when it's a rules question ({{vars.ruleset}}).
- Never move the story forward, never resolve actions, never reveal secrets the character couldn't know.`,
        prompt: `${PARTY_CONTEXT}

## Question from {{vars.asker}}
{{question}}

## Rules and memory
{{inputs}}`,
      }),
    ],
    [edge('in', 'rules'), edge('in', 'memory'), edge('rules', 'answer'), edge('memory', 'answer')],
  ),
  canvas(
    'dnd-sheet',
    'DungeonMind: character sheet',
    'A full, legal character sheet from a short description (DungeonMind validates it).',
    [
      node('in', 'input', 'input', 0),
      node('rules', 'memory', 'rules', 250, { mode: 'search', key: 'rules:{{vars.ruleset}}', limit: 6 }),
      node('sheet', 'llm', 'sheet', 500, {
        json: true,
        numCtx: 16384,
        temperature: 0.6,
        jsonSchema: `{"name":string,"species":string,"subspecies"?:string,"class":string,"subclass"?:string,"background":string,"level":number,"abilities":{"str":number,"dex":number,"con":number,"int":number,"wis":number,"cha":number},"abilityMethod":"standard"|"pointbuy","backgroundBonus"?:{[ability:string]:number},"skills":[string],"cantrips":[string],"spells":[string],"equipment":[string],"alignment"?:string,"appearance":string,"personality":string,"backstory":string}`,
        system: `You build legal D&D 5e ({{vars.ruleset}}) player characters at level {{vars.level}}. Use only the options listed. Base ability scores BEFORE species/background bonuses, using the standard array (15,14,13,12,10,8) or 27-point buy. Skills: the class's allowed choices (ids like "stealth"). Spells: ids from the class list, within the character's slot levels and counts. Reply with JSON only.`,
        prompt: `Player's idea: {{question}}

## Allowed options
{{vars.options}}

## Rules
{{inputs}}`,
      }),
    ],
    [edge('in', 'rules'), edge('rules', 'sheet')],
  ),
  canvas(
    'dnd-portrait',
    'DungeonMind: portraits',
    'Four portrait options for a character (DungeonMind).',
    [
      node('in', 'input', 'input', 0),
      node('prompt', 'llm', 'prompt', 250, {
        temperature: 0.7,
        system: 'You write prompts for an image model. Reply with one paragraph only, no preamble.',
        prompt: `Write an image prompt for a fantasy character portrait: head and shoulders, dramatic painterly lighting, dark fantasy, detailed face, no text. Style: {{vars.style}}.
Character: {{question}}`,
      }),
      node('portraits', 'image', 'portraits', 500, { batch: 4, width: 768, height: 1024, negative: 'text, watermark, blurry, deformed hands, extra limbs' }),
    ],
    [edge('in', 'prompt'), edge('prompt', 'portraits')],
  ),
  canvas(
    'dnd-scene',
    'DungeonMind: scene image',
    'One illustration of the current scene (DungeonMind).',
    [
      node('in', 'input', 'input', 0),
      node('scene', 'image', 'scene', 300, { batch: 1, width: 1216, height: 704, prompt: 'Dark fantasy illustration, cinematic, painterly, moody light, no text: {{question}}', negative: 'text, watermark, blurry' }),
    ],
    [edge('in', 'scene')],
  ),
  // ---- M9: the AI Trainer (simulated players, the judge, scenarios, the improvement report) ----
  canvas(
    'dnd-player',
    'DungeonMind: simulated player',
    'A fake player for the AI Trainer: one action in character, played as a persona (DungeonMind).',
    [
      node('in', 'input', 'input', 0),
      node('action', 'llm', 'action', 300, {
        numCtx: 16384,
        temperature: 1,
        system: `You play one player character at a D&D 5e table ({{vars.ruleset}}), to test the AI Dungeon Master. Stay in your persona:
- "reckless fighter": charges in, attacks first, ignores danger.
- "rules-lawyer": argues the rules and tries to use resources the character no longer has (spent spell slots, used-up features, items not in the inventory).
- "sneaky rogue": sneaks, steals, lies, looks for traps and shortcuts.
- "healer": keeps the party alive, heals and buffs, uses spells.
- "typo-heavy casual": short, lazy, misspelled actions ("i hit teh goblin w my sord").
Write ONE action, as the player would type it at the table, in the first person, at most 2 sentences. No narration of results, no dice.`,
        prompt: `Persona: {{vars.persona}}

## Your character
{{vars.character}}

## The scene (what the DM just said)
{{vars.scene}}

## The DM's suggested choices (you may ignore them)
{{vars.choices}}

{{question}}`,
      }),
    ],
    [edge('in', 'action')],
  ),
  canvas(
    'dnd-judge',
    'DungeonMind: judge',
    "Checks one simulated DM turn: rules, numbers, resources, contradictions, JSON, and the story (DungeonMind's AI Trainer).",
    [
      node('in', 'input', 'input', 0),
      node('verdict', 'llm', 'verdict', 300, {
        json: true,
        numCtx: 32768,
        temperature: 0.1,
        jsonSchema: `{"errors":[{"type":"roll"|"number"|"resource"|"contradiction"|"json","detail":string}],"story":number,"corrected":{"narration"?:string,"state"?:object}|null}`,
        system: `You are a strict judge of an AI Dungeon Master in D&D 5e ({{vars.ruleset}}). Think step by step, then reply with JSON only.
Check the DM's turn against the party state, the declared actions, the server's dice results and the Bookkeeper's notes:
- "roll": a needed roll was not asked for, or a roll was resolved that was never made.
- "number": HP, damage, gold, XP or other numbers that don't match the dice results or the sheet.
- "resource": spell slots, features, ammunition or items used that the character doesn't have left.
- "contradiction": the narration contradicts the party state, the campaign or itself.
- "json": the state JSON is broken, incomplete or doesn't match the narration.
"story": 1-10 for the narration as a story (vivid, fair, ends on a choice, respects player agency).
"corrected": the turn rewritten without the errors (only the parts that change: "narration" and/or "state"), or null when there were none.`,
        prompt: `## Party state (before the turn)
{{vars.party}}

## Declared actions
{{vars.actions}}

## Dice results (server-rolled, final)
{{vars.results}}

## The Bookkeeper's notes (what the server corrected or refused)
{{vars.notes}}

## The DM's narration
{{vars.narration}}

## The DM's state JSON
{{vars.state}}`,
      }),
    ],
    [edge('in', 'verdict')],
  ),
  canvas(
    'dnd-scenarios',
    'DungeonMind: scenarios',
    "Writes test scenarios (starting situations) for the AI Trainer's simulator (DungeonMind).",
    [
      node('in', 'input', 'input', 0),
      node('scenarios', 'llm', 'scenarios', 300, {
        json: true,
        numCtx: 16384,
        temperature: 0.95,
        jsonSchema: `{"scenarios":[string]}`,
        system: `You write starting situations for D&D 5e test games. Each one is 2-4 sentences: where the party is, what is happening, and what pressure forces a choice. Mix fights, social scenes, traps, puzzles, resource-hungry moments (spells, healing, ammunition, gold) and moral choices. ${TONE}
Reply with JSON only.`,
        prompt: `Write {{vars.count}} distinct scenarios on this theme: {{question}}`,
      }),
    ],
    [edge('in', 'scenarios')],
  ),
  canvas(
    'dnd-report',
    'DungeonMind: improvement report',
    "Turns the AI Trainer's findings into a Markdown improvement report to paste into a coding chat (DungeonMind).",
    [
      node('in', 'input', 'input', 0),
      node('report', 'llm', 'report', 300, {
        numCtx: 65536,
        temperature: 0.3,
        system: `You are a senior engineer improving DungeonMind, a D&D site whose AI Dungeon Master runs on HiveMind canvases. You get the errors the judge and the Bookkeeper found in simulated and real games, with example turns, the current prompts and the scoreboard. Think it through, then write ONE Markdown document meant to be pasted into a coding chat. Sections, in this order:
# DungeonMind improvement report
## Top errors (most frequent first; for each: what goes wrong, how often, 1-2 real example turns quoted briefly)
## Prompt changes (concrete edits to scripts/build-canvases.mjs: which canvas and block, the old text, the new text)
## Code changes (Bookkeeper and engine: file paths such as server/src/game/bookkeeper.ts, server/src/game/engine.ts, server/src/game/turn.ts, what to change and why)
## Model advice (which DM model to use or train, from the scoreboard)
Be specific and short. Only suggest what the data supports.`,
        prompt: `## Scoreboard
{{vars.scoreboard}}

## Errors with example turns
{{vars.errors}}

## Current prompts (from scripts/build-canvases.mjs)
{{vars.prompts}}

{{question}}`,
      }),
    ],
    [edge('in', 'report')],
  ),
];

for (const c of canvases) writeFileSync(new URL(`../hivemind/${c.id}.canvas.json`, import.meta.url), JSON.stringify(c, null, 2) + '\n');
console.log(`wrote ${canvases.length} canvases`);
