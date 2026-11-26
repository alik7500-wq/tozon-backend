import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { LeadPoolWorkerService } from '../modules/leads/leadPoolWorker.service.js';

export async function runLeadPoolCli({
  argv = process.argv,
  env = process.env,
  service = LeadPoolWorkerService,
  logger = console
} = {}) {
  const once = argv.includes('--once') || env.LEAD_POOL_WORKER_ONCE === 'true';
  const forceOverride = argv.includes('--force-override');
  const intervalMs = Math.max(5000, Number(env.LEAD_POOL_WORKER_INTERVAL_MS || 30000));
  const batchSize = Math.min(100, Math.max(1, Number(env.LEAD_POOL_WORKER_BATCH_SIZE || 25)));

  if (forceOverride && !once) {
    logger.error('[lead-pool-cli] --force-override is only allowed in --once mode');
    return { exitCode: 1, error: 'FORCE_OVERRIDE_REQUIRES_ONCE' };
  }

  if (once) {
    const result = await service.runOnce({ batchSize, ignoreEnabled: forceOverride });
    logger.info('[lead-pool-cli] run-once completed:', result);
    return { exitCode: 0, result };
  }

  if (env.LEAD_POOL_WORKER_ENABLED !== 'true') {
    logger.info('[lead-pool-cli] skipped: LEAD_POOL_WORKER_ENABLED is not true');
    return { exitCode: 0, result: { skipped: true, reason: 'POOL_WORKER_DISABLED_ENV' } };
  }

  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  logger.info(`[lead-pool-cli] started loop (interval=${intervalMs}ms, batch=${batchSize})`);
  while (!stopped) {
    try {
      await service.runOnce({ batchSize, ignoreEnabled: false });
    } catch (err) {
      logger.error('[lead-pool-cli] batch error:', err?.message || 'UNKNOWN');
    }
    if (!stopped) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return { exitCode: 0 };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  runLeadPoolCli()
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((err) => {
      console.error('[lead-pool-cli] fatal:', err?.message || 'UNKNOWN');
      process.exit(1);
    });
}
