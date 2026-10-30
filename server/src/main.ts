import { buildApp } from './app.js';
import { ensureAdmin } from './auth/index.js';
import { config } from './config.js';
import { recoverInterrupted } from './game/turn.js';
import { startScheduler } from './jobs.js';
import { recoverSims } from './trainer/sim.js';

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

await ensureAdmin();
recoverInterrupted();
recoverSims();
const app = await buildApp();
startScheduler();

// Clean stop (docker stop, Unraid update): Node as PID 1 ignores SIGTERM unless handled.
const stop = async () => {
  await app.close().catch(() => {});
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

await app.listen({ port: config.port, host: config.host });
