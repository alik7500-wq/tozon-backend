// Import database-dependent modules only after the opt-in check.
// connection.js exits the process if Supabase credentials are absent.
async function main() {
  if (process.env.LEAD_QUEUE_SCHEDULER_ENABLED !== 'true') {
    console.log('[lead-queue-scheduler] Disabled; no changes made');
    return;
  }

  const { connectDB } = await import('../../db/connection.js');
  const { processScheduledLeadQueue } = await import('./leadQueueScheduler.service.js');
  connectDB();
  const result = await processScheduledLeadQueue();
  console.log('[lead-queue-scheduler]', JSON.stringify(result));
}

main().catch(error => {
  console.error('[lead-queue-scheduler] Failed:', error?.message);
  process.exitCode = 1;
});
