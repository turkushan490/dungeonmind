# DungeonMind

Self-hostable group tabletop RPG (D&D 5e: SRD 5.1 / 2014 and SRD 5.2 / 2024) with an **AI Dungeon Master**, powered by [HiveMind](https://github.com/turkushan490/hivemind).

Groups play together in the browser. The AI makes the adventure, narrates and offers choices; **the server owns every number**: dice, hit points, spell slots and feature uses are tracked every turn.

- One Docker container on port **4830**, CPU only, everything in `/data` (SQLite).
- Image: `ghcr.io/turkushan490/dungeonmind:latest` (built by GitHub Actions). `:full` adds the Chatterbox voice engine.
- Unraid: Community Apps template in [`templates/dungeonmind.xml`](templates/dungeonmind.xml).
- **Adults only (18+).** Every account confirms its age once.

## Quick start

```bash
docker run -d --name dungeonmind -p 4830:4830 -v /path/to/appdata:/data \
  -e AUTH_MODE=builtin \
  -e HIVEMIND_URL=http://192.168.1.10:4820 -e HIVEMIND_TOKEN=hm_xxx \
  ghcr.io/turkushan490/dungeonmind:latest
```

Open `http://<host>:4830`, create the first account (it becomes the admin), then follow [docs/GUIDE.md](docs/GUIDE.md).

## Environment

| Variable | Default | What |
|---|---|---|
| `PORT` | `4830` | Listen port |
| `DATA_DIR` | `/data` | Database, images, audio cache, voice models |
| `AUTH_MODE` | `builtin` | `builtin` (accounts in the app) or `header` (forward-auth sets `X-Auth-User` / `X-Auth-Email`) |
| `AUTH_HEADER_TRUSTED_IPS` | – | header mode: only these proxy IPs may set the headers |
| `AUTH_LOGOUT_URL` | – | header mode: where "Log out" goes |
| `HIVEMIND_URL`, `HIVEMIND_TOKEN` | – | Seed the HiveMind connection (changeable in Settings) |
| `SECURE_COOKIES` | `false` | `true` behind HTTPS |
| `SECRET_KEY` | generated | Encrypts the stored HiveMind token |
| `TTS_ENGINE` | `kokoro` | `kokoro`, `chatterbox` (`:full` image) or `off`; changeable in Settings |

## Development

```bash
npm install
npm run dev:server   # http://localhost:4830
npm run dev:web      # http://localhost:5174 (proxies /api and /socket.io)
npm run typecheck && npm test
```

Node 24 (≥ 22.13), TypeScript, Fastify, Socket.IO, `node:sqlite`, React + Vite + Tailwind. Tests use vitest and a fake HiveMind server.

```
packages/shared   types shared by server, web and the Android app
server/src        app.ts · auth/ · db.ts · realtime.ts · hivemind.ts · game/ · rules/ · tts/
server/data       SRD 5.1 + 5.2 rules data (CC-BY-4.0)
web/src           Lobby · Characters · Adventure setup · Table · Settings · Guide
hivemind/         the canvases DungeonMind installs into HiveMind
templates/        Unraid Community Apps template
docs/             PLAN.md · HIVEMIND_CHANGES.md · GUIDE.md
```

## License & attribution

DungeonMind is free software under the **AGPL-3.0**.

This work includes material from the **System Reference Document 5.1** and **System Reference Document 5.2** by Wizards of the Coast LLC, available at <https://www.dndbeyond.com/srd>, licensed under the [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/legalcode). The rules data was imported from the [5e-bits 5e-database](https://github.com/5e-bits/5e-database) (MIT). DungeonMind is not affiliated with or endorsed by Wizards of the Coast.
