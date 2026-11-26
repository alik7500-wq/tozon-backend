import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { OutboxWorkerService } from '../modules/outbox/outboxWorker.service.js';

export async function runOutboxCli({
  argv = process.argv,
  env = process.env,
  service = OutboxWorkerService,
  logger = console
} = {}) {
  const once = argv.includes('--once') || env.OUTBOX_WORKER_ONCE === 'true';
  const forceOverride = argv.includes('--force-override');
  const intervalMs = Math.max(2000, Number(env.OUTBOX_WORKER_INTERVAL_MS || 5000));
  const batchSize = Math.min(100, Math.max(1, Number(env.OUTBOX_WORKER_BATCH_SIZE || 25)));
  const leaseSeconds = Math.min(600, Math.max(5, Number(env.OUTBOX_WORKER_LEASE_SECONDS || 60)));

  if (forceOverride && !once) {
    logger.error('[outbox-cli] --force-override is only allowed in --once mode');
    return { exitCode: 1, error: 'FORCE_OVERRIDE_REQUIRES_ONCE' };
  }

  if (once) {
    if (forceOverride) {
      logger.warn('[outbox-cli] MANUAL_CLI_OVERRIDE enabled');
    }
    const result = await service.runOnce({
      workerId: `cli_${process.pid}`,
      batchSize,
      leaseSeconds,
      ignoreEnabled: forceOverride
    });
    logger.info('[outbox-cli] run-once completed:', result);
    return { exitCode: 0, result };
  }

  if (env.OUTBOX_WORKER_ENABLED !== 'true') {
    logger.info('[outbox-cli] skipped: OUTBOX_WORKER_ENABLED is not true (use --once --force-override for manual run)');
    return { exitCode: 0, result: { skipped: true, reason: 'OUTBOX_DISABLED_ENV' } };
  }

  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  logger.info(`[outbox-cli] started loop (interval=${intervalMs}ms, batch=${batchSize}, lease=${leaseSeconds}s)`);
  while (!stopped) {
    try {
      await service.runOnce({ batchSize, leaseSeconds, ignoreEnabled: false });
    } catch (err) {
      logger.error('[outbox-cli] batch error:', err?.message || 'UNKNOWN');
    }
    if (!stopped) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return { exitCode: 0 };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  runOutboxCli()
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((err) => {
      console.error('[outbox-cli] fatal:', err?.message || 'UNKNOWN');
      process.exit(1);
    });
}
