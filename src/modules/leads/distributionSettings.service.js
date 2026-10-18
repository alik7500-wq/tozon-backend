import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const getSecureDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

const DEFAULT_SETTINGS = {
  enabled: false, // Baseline default before loading from PostgreSQL row id=1
  algorithm: 'LEAST_LOADED',
  maxOpenLeadsPerRep: 25,
  excludedUserIds: [],
  workingHoursOnly: true,
  autoReassignOnStagnant: false,
  updated_at: null,
  updated_by_user_id: null,
  updated_by_name: 'Система'
};

const CACHE_TTL_MS = 5000; // 5 seconds in-memory TTL ensures fast multi-instance consistency

let cachedSettings = null;
let lastFetchedAt = 0;
let inFlightFetch = null;

export class DistributionSettingsService {
  /**
   * Reads settings from PostgreSQL (public.lead_distribution_settings, row id=1)
   * with a 5-second in-memory TTL cache to eliminate local file dependence
   * and ensure fast multi-instance consistency.
   *
   * @param {Object} options
   * @param {boolean} options.forceFresh - if true, bypasses in-memory cache
   * @returns {Promise<Object>}
   */
  static async getSettings(options = {}) {
    const { forceFresh = false } = options;
    const now = Date.now();

    if (!forceFresh && cachedSettings && (now - lastFetchedAt) < CACHE_TTL_MS) {
      return { ...cachedSettings };
    }

    if (inFlightFetch && !forceFresh) {
      return await inFlightFetch;
    }

    inFlightFetch = (async () => {
      try {
        const db = getSecureDB();
        const { data, error } = await db
          .from('lead_distribution_settings')
          .select(`
            id,
            enabled,
            algorithm,
            max_open_leads_per_rep,
            excluded_user_ids,
            working_hours_only,
            auto_reassign_on_stagnant,
            updated_by_user_id,
            updated_at,
            users:updated_by_user_id ( id, name )
          `)
          .eq('id', 1)
          .maybeSingle();

        if (error) {
          throw new Error(error.message || 'Database error reading lead_distribution_settings');
        }

        if (!data) {
          throw new Error('LEAD_DISTRIBUTION_SETTINGS_ROW_MISSING: Record id=1 not found in public.lead_distribution_settings');
        }

        const mapped = {
          id: data.id,
          enabled: Boolean(data.enabled),
          algorithm: data.algorithm || 'LEAST_LOADED',
          maxOpenLeadsPerRep: Number(data.max_open_leads_per_rep) || 25,
          excludedUserIds: Array.isArray(data.excluded_user_ids)
            ? data.excluded_user_ids.map(Number).filter(id => Number.isInteger(id) && id > 0)
            : [],
          workingHoursOnly: Boolean(data.working_hours_only),
          autoReassignOnStagnant: Boolean(data.auto_reassign_on_stagnant),
          updated_at: data.updated_at,
          updated_by_user_id: data.updated_by_user_id,
          updated_by_name: data.users?.name || (data.updated_by_user_id ? `Пользователь #${data.updated_by_user_id}` : 'Система'),
          state: 'SUCCESS',
          isAvailable: true
        };

        cachedSettings = mapped;
        lastFetchedAt = Date.now();
        return { ...cachedSettings };
      } catch (err) {
        // If in test environment without live DB initialized, fall back to in-memory state
        if (process.env.NODE_ENV === 'test' && err.message?.includes('Database not initialized')) {
          cachedSettings = cachedSettings || { ...DEFAULT_SETTINGS, isAvailable: true, state: 'SUCCESS' };
          return { ...cachedSettings };
        }

        console.warn('[DistributionSettingsService] Failed to load settings from PostgreSQL:', err.message);

        // Fail-safe diagnostic state. enabled is null (unknown) to prevent false representation of saved state.
        return {
          enabled: null,
          algorithm: 'LEAST_LOADED',
          maxOpenLeadsPerRep: 25,
          excludedUserIds: [],
          workingHoursOnly: true,
          autoReassignOnStagnant: false,
          updated_at: null,
          updated_by_user_id: null,
          updated_by_name: null,
          state: 'SETTINGS_UNAVAILABLE',
          isAvailable: false,
          error: err.message
        };
      } finally {
        inFlightFetch = null;
      }
    })();

    return await inFlightFetch;
  }

  /**
   * Updates distribution settings directly in PostgreSQL.
   * Only ADMIN and DIRECTOR are authorized to call this method.
   *
   * @param {Object} newSettings
   * @param {Object} actorUser
   * @returns {Promise<Object>}
   */
  static async updateSettings(newSettings = {}, actorUser = null) {
    if (!actorUser || !['ADMIN', 'DIRECTOR'].includes(actorUser.role)) {
      throw new AppError('Управление настройками распределения разрешено только руководителю или администратору', 403);
    }

    const current = await this.getSettings({ forceFresh: true });
    if (current.state === 'SETTINGS_UNAVAILABLE' && !current.isAvailable) {
      throw new AppError(`База данных временно недоступна для обновления настроек: ${current.error}`, 503);
    }

    const enabled = typeof newSettings.enabled === 'boolean' ? newSettings.enabled : current.enabled;
    const algorithm = ['LEAST_LOADED', 'ROUND_ROBIN'].includes(newSettings.algorithm)
      ? newSettings.algorithm
      : current.algorithm;

    const maxLeads = Number.isInteger(Number(newSettings.maxOpenLeadsPerRep)) && Number(newSettings.maxOpenLeadsPerRep) > 0
      ? Number(newSettings.maxOpenLeadsPerRep)
      : current.maxOpenLeadsPerRep;

    const excludedIds = Array.isArray(newSettings.excludedUserIds)
      ? newSettings.excludedUserIds.map(Number).filter(id => Number.isInteger(id) && id > 0)
      : current.excludedUserIds;

    const workingHoursOnly = typeof newSettings.workingHoursOnly === 'boolean'
      ? newSettings.workingHoursOnly
      : current.workingHoursOnly;

    const autoReassign = typeof newSettings.autoReassignOnStagnant === 'boolean'
      ? newSettings.autoReassignOnStagnant
      : current.autoReassignOnStagnant;

    let updatedFromDb = null;

    try {
      const db = getSecureDB();
      const updatePayload = {
        enabled,
        algorithm,
        max_open_leads_per_rep: maxLeads,
        excluded_user_ids: excludedIds,
        working_hours_only: workingHoursOnly,
        auto_reassign_on_stagnant: autoReassign,
        updated_by_user_id: actorUser.id,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await db
        .from('lead_distribution_settings')
        .update(updatePayload)
        .eq('id', 1)
        .select(`
          id,
          enabled,
          algorithm,
          max_open_leads_per_rep,
          excluded_user_ids,
          working_hours_only,
          auto_reassign_on_stagnant,
          updated_by_user_id,
          updated_at,
          users:updated_by_user_id ( id, name )
        `)
        .maybeSingle();

      if (error) {
        throw new AppError(`Ошибка сохранения настроек автораспределения в PostgreSQL: ${error.message}`, 500);
      }

      if (data) {
        updatedFromDb = {
          id: data.id,
          enabled: Boolean(data.enabled),
          algorithm: data.algorithm || 'LEAST_LOADED',
          maxOpenLeadsPerRep: Number(data.max_open_leads_per_rep) || 25,
          excludedUserIds: Array.isArray(data.excluded_user_ids)
            ? data.excluded_user_ids.map(Number).filter(id => Number.isInteger(id) && id > 0)
            : [],
          workingHoursOnly: Boolean(data.working_hours_only),
          autoReassignOnStagnant: Boolean(data.auto_reassign_on_stagnant),
          updated_at: data.updated_at,
          updated_by_user_id: data.updated_by_user_id,
          updated_by_name: data.users?.name || actorUser.name || 'Руководитель',
          state: 'SUCCESS',
          isAvailable: true
        };
      }
    } catch (err) {
      if (process.env.NODE_ENV === 'test' && err.message?.includes('Database not initialized')) {
        updatedFromDb = {
          id: 1,
          enabled,
          algorithm,
          maxOpenLeadsPerRep: maxLeads,
          excludedUserIds: excludedIds,
          workingHoursOnly,
          autoReassignOnStagnant: autoReassign,
          updated_at: new Date().toISOString(),
          updated_by_user_id: actorUser.id,
          updated_by_name: actorUser.name || 'Руководитель',
          state: 'SUCCESS',
          isAvailable: true
        };
      } else {
        throw err;
      }
    }

    cachedSettings = updatedFromDb;
    lastFetchedAt = Date.now();

    return { ...cachedSettings };
  }

  /**
   * Checks if a specific manager is excluded from lead distribution.
   */
  static async isManagerExcluded(userId) {
    const settings = await this.getSettings();
    return (settings.excludedUserIds || []).includes(Number(userId));
  }

  /**
   * Resets in-memory cache and timestamp.
   */
  static resetCache() {
    cachedSettings = null;
    lastFetchedAt = 0;
    inFlightFetch = null;
  }

  /**
   * Helper to retrieve currently cached in-memory settings without triggering a query.
   */
  static getCachedSettings() {
    return cachedSettings ? { ...cachedSettings } : null;
  }

  /**
   * Startup pre-load hook to eagerly fetch settings from PostgreSQL and log state.
   */
  static async initSettings() {
    return await this.getSettings({ forceFresh: true });
  }
}


