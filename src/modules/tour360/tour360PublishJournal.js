/**
 * Durable publication journal repository. No HTTP endpoint or production migration yet.
 * Requires service-role Supabase client and tour360_publish_jobs table.
 */
const STATES = new Set(['PREPARING', 'COPYING', 'VERIFYING', 'ACTIVATING', 'COMPLETED', 'FAILED', 'NEEDS_RECOVERY']);
const ALLOWED = {
  PREPARING: ['COPYING', 'FAILED'],
  COPYING: ['VERIFYING', 'FAILED', 'NEEDS_RECOVERY'],
  VERIFYING: ['ACTIVATING', 'FAILED', 'NEEDS_RECOVERY'],
  ACTIVATING: ['COMPLETED', 'NEEDS_RECOVERY'],
  COMPLETED: [], FAILED: [], NEEDS_RECOVERY: []
};

export class Tour360PublishJournal {
  constructor(serviceDb) {
    if (!serviceDb?.from) throw new Error('SERVICE_DB_REQUIRED');
    this.db = serviceDb;
  }

  async start({ tourId, projectId, manifest }) {
    if (!Number.isSafeInteger(Number(tourId)) || !Number.isSafeInteger(Number(projectId)) || !manifest?.ready_for_publish) {
      throw new Error('INVALID_PUBLISH_JOB');
    }
    const { data, error } = await this.db.from('tour360_publish_jobs').insert({
      tour_id: Number(tourId), project_id: Number(projectId), state: 'PREPARING', manifest, copied_paths: []
    }).select().single();
    if (error) throw error;
    return data;
  }

  async transition(jobId, expectedState, nextState, patch = {}) {
    if (!STATES.has(expectedState) || !ALLOWED[expectedState]?.includes(nextState)) throw new Error('INVALID_PUBLISH_TRANSITION');
    const allowedPatch = {};
    if (patch.error_code !== undefined) allowedPatch.error_code = String(patch.error_code).slice(0, 200);
    if (patch.copied_paths !== undefined) {
      if (!Array.isArray(patch.copied_paths) || !patch.copied_paths.every(p => typeof p === 'string')) throw new Error('INVALID_COPIED_PATHS');
      allowedPatch.copied_paths = patch.copied_paths;
    }
    const { data, error } = await this.db.from('tour360_publish_jobs')
      .update({ ...allowedPatch, state: nextState, updated_at: new Date().toISOString(), ...(nextState === 'COMPLETED' ? { completed_at: new Date().toISOString() } : {}) })
      .eq('id', jobId).eq('state', expectedState).select().maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('PUBLISH_JOB_CONCURRENT_CHANGE');
    return data;
  }

  async get(jobId) {
    const { data, error } = await this.db.from('tour360_publish_jobs').select('*').eq('id', jobId).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('PUBLISH_JOB_NOT_FOUND');
    return data;
  }
}
