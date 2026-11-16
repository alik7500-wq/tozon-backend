import { connectDB } from '../../db/connection.js';
import { processScheduledLeadQueue } from './leadQueueScheduler.service.js';

async function main() {
  if (process.env.LEAD_QUEUE_SCHEDULER_ENABLED !== 'true') {
    console.log('[lead-queue-scheduler] Disabled; no changes made');
    return;
  }
  connectDB();
  const result = await processScheduledLeadQueue();
  console.log('[lead-queue-scheduler]', JSON.stringify(result));
}

main().catch(error => {
  console.error('[lead-queue-scheduler] Failed:', error?.message);
  process.exitCode = 1;
});
