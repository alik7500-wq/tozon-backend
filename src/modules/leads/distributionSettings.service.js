import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AppError } from '../../shared/errors/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE_PATH = path.resolve(__dirname, '../../../data/distribution_settings.json');

const DEFAULT_SETTINGS = {
  enabled: false, // Strictly OFF by default as required by Owner
  algorithm: 'LEAST_LOADED', // 'LEAST_LOADED' or 'ROUND_ROBIN'
  maxOpenLeadsPerRep: 25,
  excludedUserIds: [], // IDs of managers temporarily excluded (e.g., on leave)
  workingHoursOnly: false, // Route to pool if outside business hours
  autoReassignOnStagnant: false,
  updated_at: new Date().toISOString(),
  updated_by_user_id: null,
  updated_by_name: 'Система'
};

let cachedSettings = null;

export class DistributionSettingsService {
  /**
   * Reads settings with caching and file persistence.
   */
  static getSettings() {
    if (cachedSettings) return { ...cachedSettings };

    try {
      if (fs.existsSync(SETTINGS_FILE_PATH)) {
        const raw = fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8');
        cachedSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        return { ...cachedSettings };
      }
    } catch (err) {
      console.warn('[DistributionSettingsService] Failed to read settings file, using defaults:', err.message);
    }

    cachedSettings = { ...DEFAULT_SETTINGS };
    return { ...cachedSettings };
  }

  /**
   * Updates distribution settings.
   * Only ADMIN and DIRECTOR are authorized to call this method.
   */
  static updateSettings(newSettings = {}, actorUser = null) {
    if (!actorUser || !['ADMIN', 'DIRECTOR'].includes(actorUser.role)) {
      throw new AppError('Управление настройками распределения разрешено только руководителю или администратору', 403);
    }

    const current = this.getSettings();

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

    const updated = {
      ...current,
      enabled,
      algorithm,
      maxOpenLeadsPerRep: maxLeads,
      excludedUserIds: excludedIds,
      workingHoursOnly,
      updated_at: new Date().toISOString(),
      updated_by_user_id: actorUser.id,
      updated_by_name: actorUser.name || 'Руководитель'
    };

    cachedSettings = updated;

    try {
      const dir = path.dirname(SETTINGS_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(updated, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[DistributionSettingsService] Failed to persist settings to disk:', err.message);
    }

    return { ...cachedSettings };
  }

  /**
   * Check if a specific manager is currently excluded from automated lead distribution
   */
  static isManagerExcluded(userId) {
    const settings = this.getSettings();
    return (settings.excludedUserIds || []).includes(Number(userId));
  }

  /**
   * Resets in-memory cache
   */
  static resetCache() {
    cachedSettings = null;
  }
}

