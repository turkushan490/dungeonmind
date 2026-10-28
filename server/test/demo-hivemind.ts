// A scripted stand-in DM for local end-to-end checks (no GPU needed):
//   npx tsx test/demo-hivemind.ts 4899     then HIVEMIND_URL=http://127.0.0.1:4899 HIVEMIND_TOKEN=hm_test
import { FakeHiveMind, PNG, type FakeCall, type FakeRun } from './fake-hivemind.js';

const hm = new FakeHiveMind();
const port = Number(process.argv[2] || 4899);
let n = 0;

function demo(c: FakeCall): FakeRun {
  const party: string[] = c.vars.party ? JSON.parse(c.vars.party).characters.map((x: { name: string }) => x.name) : [];
  switch (c.canvasId) {
    case 'dnd-setup':
      return c.vars.stage === 'pitches'
        ? { outputs: { pitch: JSON.stringify({ pitches: [
            { title: 'The Drowned Bells', hook: 'Every night the bells of a sunken chapel ring beneath the marsh, and every morning someone in Hollowmere is gone.', tone: 'Folk horror' },
            { title: 'Ash Crown', hook: 'The old king was burned three times. He keeps coming back for his crown.', tone: 'Grim intrigue' },
            { title: 'Salt and Iron', hook: 'A smugglers’ coast where the tide brings back what the sea took.', tone: 'Coastal noir' },
            { title: 'The Last Lamp', hook: 'The final lighthouse against the endless fog is going dark.', tone: 'Siege, hope' },
          ] }) } }
        : { outputs: { pitch: JSON.stringify({ title: c.vars.pitch.split(':')[0] || 'The Drowned Bells', summary: 'A marsh village, a drowned chapel, a hag who collects voices.', fields: [
            { id: 'deadly', label: 'How deadly?', type: 'slider', min: 1, max: 5, default: 3 },
            { id: 'villain', label: 'Who rings the bells?', type: 'select', options: ['A bell-hag', 'A drowned priest', 'The village itself'], default: 'A bell-hag' },
            { id: 'themes', label: 'Themes', type: 'multi', options: ['Grief', 'Greed', 'Faith', 'Madness'], default: ['Grief'] },
            { id: 'start', label: 'Where do we start?', type: 'text', default: 'The ferry into Hollowmere' },
          ] }) } };
    case 'dnd-adjudicate': {
      const first = party[0];
      return { outputs: { rolls: JSON.stringify({ rolls: [
        { id: 'a', actor: first, kind: 'attack', target: 'The Bell-Hag', targetAc: 15, reason: 'attack' },
        { id: 'b', actor: first, kind: 'damage', target: 'The Bell-Hag', dice: '1d8+3', onHit: 'a' },
        { id: 'c', actor: 'The Bell-Hag', kind: 'attack', target: party[1] ?? first, bonus: 5, targetAc: 14 },
        { id: 'd', actor: 'The Bell-Hag', kind: 'damage', target: party[1] ?? first, dice: '2d6+2', onHit: 'c' },
        ...(party[1] ? [{ id: 'e', actor: party[1], kind: 'check', skill: 'perception', dc: 13 }] : []),
      ], resources: [] }) } };
    }
    case 'dnd-narrate': {
      n++;
      const text = c.vars.mode === 'opening'
        ? 'Rain needles the black water as the ferry noses into Hollowmere. Somewhere beneath the reeds, a bell tolls once, though no bell tower stands for miles.\n\nThe ferryman will not meet your eyes. "Off here," he says. "I don\'t go further. Not after dark."\n\nOn the jetty, a lantern swings. Beneath it waits a woman with a face like wet paper, and a smile with too many teeth.'
        : `The hag shrieks as steel finds her side, a sound like a cracked bell. She lashes back, nails like fishhooks.\n\n"Pretty voices," she croons. "I will keep yours in a jar."\n\nThe water around the jetty begins to boil with grasping, drowned hands. (turn ${n})`;
      return {
        stream: { label: 'narration', text },
        outputs: {
          narration: text,
          state: JSON.stringify({
            deltas: [],
            xp: c.vars.mode === 'opening' ? [] : [{ pc: 'all', amount: 150, reason: 'wounding the hag' }],
            npcs: [{ name: 'The Bell-Hag', hp: 45, maxHp: 45, ac: 15, dex: 2, status: 'hostile' }, { name: 'Ferryman', status: 'neutral' }],
            combat: c.vars.mode === 'opening' ? { start: true, enemies: ['The Bell-Hag'] } : null,
            zones: [{ name: 'Jetty', distances: { Ferry: 15, Reeds: 40 } }, { name: 'Ferry', distances: { Reeds: 50 } }, { name: 'Reeds', distances: {} }],
            positions: { Jetty: ['The Bell-Hag', ...(party.slice(0, 1))], Ferry: [...party.slice(1), 'Ferryman'], Reeds: [] },
            choices: Object.fromEntries(party.map((p) => [p, ['Strike at the hag', 'Cut the ferry loose', 'Shout a prayer at the water', 'Grab the lantern']])),
            speakers: [{ name: 'narrator', kind: 'narrator' }, { name: 'Ferryman', kind: 'npc', gender: 'male', age: 'old' }, { name: 'The Bell-Hag', kind: 'monster', gender: 'female', age: 'old' }],
            image: c.vars.mode === 'opening' ? 'A rain-soaked jetty in a black marsh at night, a lantern, a hag' : null,
            sceneEnd: false,
            summary: 'The hag attacks at the jetty.',
          }),
        },
        delayMs: 600,
      };
    }
    case 'dnd-chronicle':
      return { outputs: { patches: JSON.stringify({ patches: [{ section: 'Timeline', op: 'append', text: `- Turn ${n}: ${c.question.slice(0, 80).replace(/\n/g, ' ')}…` }, { section: 'NPCs', op: 'replace', text: '- **The Bell-Hag**: hostile, collects voices, voice: old crone\n- **Ferryman**: frightened, won\'t go past dark' }, { section: 'Current scene', op: 'replace', text: 'The jetty at Hollowmere, night, rain. The hag attacks.' }] }) } };
    case 'dnd-ask':
      return { outputs: { answer: 'You can grapple with one free hand. Holding a shield is fine as long as your other hand is free.' } };
    case 'dnd-sheet':
      return { outputs: { sheet: JSON.stringify({ name: 'Brakka', species: 'half-orc', class: 'barbarian', background: 'acolyte', level: 1, abilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'survival'], equipment: ['Greataxe', '2 Handaxe'], appearance: 'grey skin, braided hair', personality: 'gruff', backstory: 'exiled' }) } };
    case 'dnd-portrait':
    case 'dnd-scene': {
      const files = Array.from({ length: c.canvasId === 'dnd-portrait' ? 4 : 1 }, (_, i) => `images/demo-${Date.now()}-${i}.png`);
      for (const f of files) hm.files.set(f, PNG);
      return { outputs: { [c.canvasId === 'dnd-portrait' ? 'portraits' : 'scene']: files.map((f) => `![image](hm-file:${f})`).join('\n') } };
    }
  }
  return { outputs: {} };
}

hm.onRun = demo;
for (const id of ['dnd-setup', 'dnd-adjudicate', 'dnd-narrate', 'dnd-chronicle', 'dnd-ask', 'dnd-sheet', 'dnd-portrait', 'dnd-scene']) hm.canvases.set(id, { id, name: id, nodes: [], edges: [] });
hm.server.listen(port, '127.0.0.1', () => console.log(`demo HiveMind on http://127.0.0.1:${port} (token ${hm.token})`));
