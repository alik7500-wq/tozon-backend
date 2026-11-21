// Import database-dependent modules only after the opt-in check.
// connection.js exits the process if Supabase credentials are absent.
async function main() {
  const probeOnly = process.env.LEAD_QUEUE_CONNECTION_PROBE === 'true';
  if (!probeOnly && process.env.LEAD_QUEUE_SCHEDULER_ENABLED !== 'true') {
    console.log('[lead-queue-scheduler] Disabled; no changes made');
    return;
  }

  // Fail closed unless the target Supabase project is explicitly approved.
  // This prevents accidentally running a staging job against production.
  const expectedRef = process.env.LEAD_QUEUE_EXPECTED_PROJECT_REF;
  const configuredUrl = process.env.NODE_ENV === 'test'
    ? (process.env.TEST_SUPABASE_URL || process.env.TEST_DATABASE_URL)
    : process.env.SUPABASE_URL;
  if (!expectedRef || !/^[a-z0-9]{20}$/.test(expectedRef)) {
    throw new Error('LEAD_QUEUE_EXPECTED_PROJECT_REF_REQUIRED');
  }
  let target;
  try {
    target = new URL(configuredUrl);
  } catch {
    throw new Error('LEAD_QUEUE_SUPABASE_URL_INVALID');
  }
  if (target.protocol !== 'https:' ||
      target.hostname !== `${expectedRef}.supabase.co` ||
      target.pathname !== '/' ||
      target.search || target.hash) {
    throw new Error('LEAD_QUEUE_DATABASE_PROJECT_MISMATCH');
  }

  if (probeOnly) {
    if (process.env.LEAD_QUEUE_SCHEDULER_ENABLED === 'true') {
      throw new Error('CONNECTION_PROBE_REQUIRES_SCHEDULER_DISABLED');
    }
    const { getServiceDB } = await import('../../db/connection.js');
    const { data, error } = await getServiceDB()
      .from('lead_queue_scheduler_control')
      .select('enabled')
      .eq('id', 1)
      .single();
    if (error || !data || data.enabled !== false) {
      throw new Error('LEAD_QUEUE_CONNECTION_PROBE_FAILED');
    }
    console.log('[lead-queue-scheduler] Test database connection OK; scheduler remains disabled');
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
