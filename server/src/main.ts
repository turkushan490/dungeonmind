import { buildApp } from './app.js';
import { ensureAdmin } from './auth/index.js';
import { config } from './config.js';
import { recoverInterrupted } from './game/turn.js';

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

await ensureAdmin();
recoverInterrupted();
const app = await buildApp();

// Clean stop (docker stop, Unraid update): Node as PID 1 ignores SIGTERM unless handled.
const stop = async () => {
  await app.close().catch(() => {});
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

await app.listen({ port: config.port, host: config.host });
