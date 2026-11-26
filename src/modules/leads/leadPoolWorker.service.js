import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const getSafeDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

export class LeadPoolWorkerService {
  static async runOnce({
    batchSize = 25,
    ignoreEnabled = false,
    actorUserId = null,
    now = null
  } = {}) {
    const isManualOverride = ignoreEnabled === true;
    const db = getSafeDB();
    const empty = { scanned: 0, assigned: 0, pooled: 0, skipped_terminal: 0, errors: 0 };

    const { data: settings, error: settingsErr } = await db
      .from('lead_distribution_settings')
      .select('id, enabled, pool_worker_enabled')
      .eq('id', 1)
      .maybeSingle();

    if (settingsErr || !settings) {
      console.warn('[lead-pool-worker] skipped: SETTINGS_READ_ERROR', settingsErr?.message || 'NOT_FOUND');
      return { ...empty, skipped: true, reason: 'SETTINGS_READ_ERROR' };
    }

    const envEnabled = process.env.LEAD_POOL_WORKER_ENABLED === 'true';
    const dbEnabled = settings.pool_worker_enabled === true;

    if (!isManualOverride && (!envEnabled || !dbEnabled)) {
      const reason = !envEnabled && !dbEnabled
        ? 'POOL_WORKER_DISABLED_ENV_AND_DB'
        : (!envEnabled ? 'POOL_WORKER_DISABLED_ENV' : 'POOL_WORKER_DISABLED_DB');
      return { ...empty, skipped: true, reason };
    }

    if (isManualOverride) {
      console.info('[lead-pool-worker] MANUAL_POOL_RUN_ONCE_OVERRIDE', { actorUserId });
    }

    const { data, error } = await db.rpc('fn_run_lead_pool_batch', {
      p_batch_size: Math.min(100, Math.max(1, Number(batchSize) || 25)),
      p_ignore_enabled: isManualOverride,
      p_now: (now instanceof Date ? now.toISOString() : now) || new Date().toISOString()
    });

    if (error || !data) {
      throw new AppError(`Ошибка обработки пула неназначенных лидов: ${error?.message || 'EMPTY_RPC_RESPONSE'}`, 503);
    }

    return data;
  }

  static async getDiagnostics() {
    const db = getSafeDB();
    const { data: settings, error: settingsErr } = await db
      .from('lead_distribution_settings')
      .select('id, enabled, pool_worker_enabled, last_pool_run_at, last_pool_success_at, last_pool_error')
      .eq('id', 1)
      .maybeSingle();

    if (settingsErr || !settings) {
      throw new AppError('Не удалось получить диагностику пула лидов', 503);
    }

    const { count: unassignedCount } = await db
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .is('responsible_user_id', null)
      .is('archived_at', null)
      .neq('status', 'LOST');

    const envEnabled = process.env.LEAD_POOL_WORKER_ENABLED === 'true';
    const dbEnabled = settings.pool_worker_enabled === true;

    return {
      envEnabled,
      dbEnabled,
      effectiveActive: envEnabled && dbEnabled,
      distributionEnabled: Boolean(settings.enabled),
      unassignedCount: unassignedCount || 0,
      lastPoolRunAt: settings.last_pool_run_at || null,
      lastPoolSuccessAt: settings.last_pool_success_at || null,
      lastPoolError: settings.last_pool_error || null
    };
  }
}
