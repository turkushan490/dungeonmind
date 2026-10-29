import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/index.js';
import { db } from '../db.js';
import { addTurnHooks } from '../game/turn.js';
import { addLog } from '../game/log.js';
import { broadcast, gameCharacters, loadGame, saveGame, saveGameCharacter } from '../game/store.js';
import { titleCase } from '../game/text.js';
import { fetchFile, HiveMindError, imagePaths, runCanvas, withRetry } from '../hivemind.js';
import { saveImage } from '../images.js';
import { background } from '../jobs.js';
import { think } from '../game/queue.js';
import { loadCharacter, saveCharacter } from './characters.js';

const STYLES = ['painterly dark fantasy', 'ink and watercolor', 'grim oil painting', 'charcoal sketch', 'heroic illustration'];

/** Runs an image canvas and copies every picture into DungeonMind's own appdata. */
export async function generateImages(canvasId: string, label: string, question: string, vars: Record<string, string>, prefix: string): Promise<string[]> {
  const out = await withRetry(() => runCanvas(canvasId, question, { vars }), { attempts: 2 });
  const paths = imagePaths(out.outputs[label]?.text ?? '');
  if (!paths.length) throw new HiveMindError('HiveMind made no images (is an image model set on the canvas?)', 0, false);
  const urls: string[] = [];
  for (const p of paths.slice(0, 8)) {
    const f = await fetchFile(p);
    urls.push(saveImage(f.data, prefix));
  }
  return urls;
}

/** Library character portraits also update the copies of that character in games. */
function setPortrait(characterId: string, url: string) {
  const c = loadCharacter(characterId)!;
  c.portrait = url;
  saveCharacter(c);
  for (const r of db.prepare('SELECT game_id, id FROM game_characters WHERE source_id = ?').all(characterId) as { game_id: string; id: string }[]) {
    const gc = gameCharacters(r.game_id).find((x) => x.id === r.id);
    if (!gc) continue;
    gc.portrait = url;
    saveGameCharacter(r.game_id, gc);
    const g = loadGame(r.game_id);
    if (g) broadcast(g);
  }
  return c;
}

let hooked = false;

export function portraitRoutes(app: FastifyInstance) {
  // Scene images: when the State LLM describes a new scene, illustrate it in the background.
  if (!hooked) {
    hooked = true;
    addTurnHooks({
      afterTurn: (g, _narration, state) => {
        if (!state.image || g.settings.sceneImages === false) return;
        const prompt = String(state.image).slice(0, 600);
        void think(g.id, () => generateImages('dnd-scene', 'scene', prompt, { tableId: g.id }, 'scene'))
          .then(([url]) => {
            const fresh = loadGame(g.id);
            if (!fresh) return;
            fresh.state.sceneImage = url;
            saveGame(fresh);
            addLog(g.id, fresh.state.turn - 1, 'image', prompt, undefined, { url });
            broadcast(fresh);
          })
          .catch((err) => addLog(g.id, g.state.turn, 'note', `No scene image this time (${(err as Error).message}).`));
      },
    });
  }

  /** Four portrait options from HiveMind (dnd-portrait). Not saved until one is picked. */
  app.post('/api/characters/:id/portraits', { preHandler: requireUser }, async (req, reply) => {
    const c = loadCharacter((req.params as { id: string }).id);
    if (!c || c.ownerId !== req.user!.id) return reply.code(404).send({ error: 'Not found' });
    const style = STYLES.includes(String((req.body as { style?: string })?.style)) ? (req.body as { style: string }).style : STYLES[0];
    const who = `${c.name}, a ${titleCase(c.subspecies ?? c.species)} ${titleCase(c.class)}${c.appearance ? `. ${c.appearance}` : ''}`;
    return background(req, reply, async () => ({ options: await generateImages('dnd-portrait', 'portraits', who, { style }, 'option'), styles: STYLES }));
  });

  app.post('/api/characters/:id/portrait', { preHandler: requireUser }, async (req, reply) => {
    const c = loadCharacter((req.params as { id: string }).id);
    if (!c || c.ownerId !== req.user!.id) return reply.code(404).send({ error: 'Not found' });
    const url = String((req.body as { url?: string })?.url ?? '');
    if (!/^\/api\/images\/option-[A-Za-z0-9_-]+\.(png|jpg|webp|gif)$/.test(url)) return reply.code(400).send({ error: 'Pick one of the generated options' });
    return setPortrait(c.id, url);
  });

  /** Upload your own portrait (raw image body). */
  app.post('/api/characters/:id/portrait/upload', { preHandler: requireUser }, async (req, reply) => {
    const c = loadCharacter((req.params as { id: string }).id);
    if (!c || c.ownerId !== req.user!.id) return reply.code(404).send({ error: 'Not found' });
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'Send the image file' });
    try {
      return setPortrait(c.id, saveImage(req.body, 'portrait'));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
