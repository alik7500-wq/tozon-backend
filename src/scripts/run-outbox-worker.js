import 'dotenv/config';
import { OutboxWorkerService } from '../modules/outbox/outboxWorker.service.js';

const once = process.argv.includes('--once') || process.env.OUTBOX_WORKER_ONCE === 'true';
const forceOverride = process.argv.includes('--force-override');
const intervalMs = Math.max(2000, Number(process.env.OUTBOX_WORKER_INTERVAL_MS || 5000));
const batchSize = Math.min(100, Math.max(1, Number(process.env.OUTBOX_WORKER_BATCH_SIZE || 25)));
const leaseSeconds = Math.min(600, Math.max(5, Number(process.env.OUTBOX_WORKER_LEASE_SECONDS || 60)));

async function main() {
  if (process.env.OUTBOX_WORKER_ENABLED !== 'true' && !forceOverride) {
    console.info('[outbox-cli] skipped: OUTBOX_WORKER_ENABLED is not true (use --force-override for manual run)');
    process.exit(0);
  }
  if (forceOverride) {
    console.warn('[outbox-cli] MANUAL_CLI_OVERRIDE enabled');
  }

  if (once) {
    const result = await OutboxWorkerService.runOnce({ batchSize, leaseSeconds, ignoreEnabled: forceOverride });
    console.info('[outbox-cli] run-once completed:', result);
    process.exit(0);
  }

  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.info(`[outbox-cli] started loop (interval=${intervalMs}ms, batch=${batchSize}, lease=${leaseSeconds}s)`);
  while (!stopped) {
    try {
      await OutboxWorkerService.runOnce({ batchSize, leaseSeconds });
    } catch (err) {
      console.error('[outbox-cli] batch error:', err?.message || 'UNKNOWN');
    }
    if (!stopped) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[outbox-cli] fatal:', err?.message || 'UNKNOWN');
  process.exit(1);
});
