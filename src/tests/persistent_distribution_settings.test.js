import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DistributionSettingsService } from '../modules/leads/distributionSettings.service.js';
import { RoundRobinService } from '../modules/leads/roundRobin.service.js';
import * as dbConnection from '../db/connection.js';

describe('TOZON CRM — Phase 3.6.1 Persistent Distribution Settings Test Suite', () => {
  let mockDb;
  let mockRow;

  beforeEach(() => {
    vi.restoreAllMocks();
    DistributionSettingsService.resetCache();

    mockRow = {
      id: 1,
      enabled: true,
      algorithm: 'LEAST_LOADED',
      max_open_leads_per_rep: 25,
      excluded_user_ids: [],
      working_hours_only: true,
      auto_reassign_on_stagnant: false,
      updated_by_user_id: 1,
      updated_at: '2026-10-18T17:47:54.026Z',
      users: { id: 1, name: 'Admin' }
    };

    mockDb = {
      from: vi.fn((table) => {
        if (table === 'lead_distribution_settings') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(async () => {
              if (mockDb._failQuery) {
                return { data: null, error: { message: 'Supabase connection timeout / DB unavailable' } };
              }
              return { data: { ...mockRow }, error: null };
            }),
            update: vi.fn((payload) => {
              if (mockDb._failQuery) {
                return {
                  eq: vi.fn().mockReturnThis(),
                  select: vi.fn().mockReturnThis(),
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: null,
                    error: { message: 'Database write error' }
                  })
                };
              }
              Object.assign(mockRow, payload, {
                max_open_leads_per_rep: payload.max_open_leads_per_rep ?? mockRow.max_open_leads_per_rep,
                working_hours_only: payload.working_hours_only ?? mockRow.working_hours_only,
                excluded_user_ids: payload.excluded_user_ids ?? mockRow.excluded_user_ids,
                users: { id: payload.updated_by_user_id || 1, name: 'Admin' }
              });
              return {
                eq: vi.fn().mockReturnThis(),
                select: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { ...mockRow },
                  error: null
                })
              };
            })
          };
        }
        const fallbackBuilder = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockImplementation(() => Promise.resolve({ data: [], error: null })),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
        };
        fallbackBuilder.then = (onRes, onRej) => Promise.resolve({ data: [], error: null }).then(onRes, onRej);
        return fallbackBuilder;
      })
    };

    vi.spyOn(dbConnection, 'getServiceDB').mockReturnValue(mockDb);
    vi.spyOn(dbConnection, 'getDB').mockReturnValue(mockDb);
  });

  afterEach(() => {
    DistributionSettingsService.resetCache();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. PostgreSQL As Single Source of Truth
  // =========================================================================
  describe('1. PostgreSQL Single Source of Truth & Field Mapping', () => {
    it('loads settings directly from public.lead_distribution_settings row id=1', async () => {
      const settings = await DistributionSettingsService.getSettings({ forceFresh: true });

      expect(settings).toBeDefined();
      expect(settings.state).toBe('SUCCESS');
      expect(settings.isAvailable).toBe(true);
      expect(settings.enabled).toBe(true);
      expect(settings.algorithm).toBe('LEAST_LOADED');
      expect(settings.maxOpenLeadsPerRep).toBe(25);
      expect(settings.workingHoursOnly).toBe(true);
      expect(settings.excludedUserIds).toEqual([]);
      expect(settings.updated_by_name).toBe('Admin');
      expect(mockDb.from).toHaveBeenCalledWith('lead_distribution_settings');
    });

    it('returns a standard Promise resolving to the mapped settings object without unsafe sync decoration', async () => {
      const promise = DistributionSettingsService.getSettings();
      expect(promise instanceof Promise).toBe(true);
      // Synchronous property should be undefined (no unsafe decoration)
      expect(promise.enabled).toBeUndefined();

      const resolved = await promise;
      expect(resolved.enabled).toBe(true);
      expect(resolved.algorithm).toBe('LEAST_LOADED');
    });

    it('guarantees admin disabling auto-distribution takes effect immediately before next lead assignment', async () => {
      // 1. Initial state in DB is enabled: true
      const initial = await DistributionSettingsService.getSettings({ forceFresh: true });
      expect(initial.enabled).toBe(true);

      // 2. Administrator disables distribution via updateSettings
      const adminActor = { id: 1, role: 'ADMIN', name: 'Alik Admin' };
      await DistributionSettingsService.updateSettings({ enabled: false }, adminActor);

      // 3. Next lead arrival must immediately see enabled: false with ZERO stale delay
      const assignment = await RoundRobinService.resolveAssignment(null, null);
      expect(assignment.responsible_user_id).toBeNull();
      expect(assignment.assignment_type).toBe('POOL');
      expect(assignment.reason).toContain('выключено руководителем');
    });
  });

  // =========================================================================
  // 2. Persistence on Updates via getSecureDB()
  // =========================================================================
  describe('2. Updating Settings via getSecureDB()', () => {
    it('persists updated settings to PostgreSQL and refreshes in-memory cache', async () => {
      const actor = { id: 1, role: 'ADMIN', name: 'Alik Admin' };
      const updated = await DistributionSettingsService.updateSettings({
        enabled: true,
        algorithm: 'ROUND_ROBIN',
        maxOpenLeadsPerRep: 30,
        workingHoursOnly: false,
        excludedUserIds: [2, 5]
      }, actor);

      expect(updated.enabled).toBe(true);
      expect(updated.algorithm).toBe('ROUND_ROBIN');
      expect(updated.maxOpenLeadsPerRep).toBe(30);
      expect(updated.workingHoursOnly).toBe(false);
      expect(updated.excludedUserIds).toEqual([2, 5]);

      // Verify that next getSettings reads the updated state from cache/DB
      const current = await DistributionSettingsService.getSettings();
      expect(current.algorithm).toBe('ROUND_ROBIN');
      expect(current.maxOpenLeadsPerRep).toBe(30);
    });

    it('rejects updates from unauthorized roles with 403 Forbidden', async () => {
      const financeUser = { id: 4, role: 'FINANCE_MANAGER', name: 'Finance' };
      await expect(DistributionSettingsService.updateSettings({ enabled: false }, financeUser))
        .rejects
        .toThrow('Управление настройками распределения разрешено только руководителю или администратору');
    });
  });

  // =========================================================================
  // 3. Database Failure & Diagnostic State SETTINGS_UNAVAILABLE
  // =========================================================================
  describe('3. Database Failure & Diagnostic State SETTINGS_UNAVAILABLE', () => {
    it('returns SETTINGS_UNAVAILABLE and sets enabled: null when PostgreSQL is down', async () => {
      mockDb._failQuery = true;

      const settings = await DistributionSettingsService.getSettings({ forceFresh: true });

      expect(settings.state).toBe('SETTINGS_UNAVAILABLE');
      expect(settings.isAvailable).toBe(false);
      expect(settings.enabled).toBeNull(); // Strictly null, never false disguised as configured
      expect(settings.error).toContain('timeout');
    });

    it('enforces fail-safe closed behavior: routes leads to POOL with diagnostic reason when DB is down', async () => {
      mockDb._failQuery = true;

      const assignment = await RoundRobinService.resolveAssignment(null, null);

      expect(assignment.responsible_user_id).toBeNull();
      expect(assignment.assignment_type).toBe('POOL');
      expect(assignment.reason).toContain('SETTINGS_UNAVAILABLE');
      expect(assignment.reason).toContain('Настройки распределения временно недоступны');
      // Must NOT claim that manager disabled it
      expect(assignment.reason).not.toContain('выключено руководителем');
    });
  });

  // =========================================================================
  // 4. Multi-Instance Consistency & Cache TTL
  // =========================================================================
  describe('4. Multi-Instance Consistency & Cache Invalidation', () => {
    it('caches for 5 seconds to reduce DB load, but respects forceFresh and resetCache', async () => {
      // First read: queries DB
      await DistributionSettingsService.getSettings({ forceFresh: true });
      expect(mockDb.from).toHaveBeenCalledTimes(1);

      // Second read within 5s: hits cache, 0 extra DB calls
      await DistributionSettingsService.getSettings();
      expect(mockDb.from).toHaveBeenCalledTimes(1);

      // resetCache immediately clears cache
      DistributionSettingsService.resetCache();
      await DistributionSettingsService.getSettings();
      expect(mockDb.from).toHaveBeenCalledTimes(2);

      // forceFresh bypasses TTL cache
      await DistributionSettingsService.getSettings({ forceFresh: true });
      expect(mockDb.from).toHaveBeenCalledTimes(3);
    });

    it('simulates external update from another Backend instance picked up on fresh read', async () => {
      // Instance A reads current settings
      const initial = await DistributionSettingsService.getSettings({ forceFresh: true });
      expect(initial.maxOpenLeadsPerRep).toBe(25);

      // Another instance B modifies PostgreSQL directly
      mockRow.max_open_leads_per_rep = 50;
      mockRow.algorithm = 'ROUND_ROBIN';

      // After TTL or forceFresh, this instance picks up Instance B changes
      const synced = await DistributionSettingsService.getSettings({ forceFresh: true });
      expect(synced.maxOpenLeadsPerRep).toBe(50);
      expect(synced.algorithm).toBe('ROUND_ROBIN');
    });
  });

  // =========================================================================
  // 5. Backend Restart & Startup Pre-load
  // =========================================================================
  describe('5. Backend Restart & Startup Pre-load', () => {
    it('initSettings() on startup loads enabled: true directly from PostgreSQL', async () => {
      // Simulate Render restart: in-memory cache is empty
      DistributionSettingsService.resetCache();
      expect(DistributionSettingsService.getCachedSettings()).toBeNull();

      // Startup hook runs
      const startupSettings = await DistributionSettingsService.initSettings();

      expect(startupSettings.enabled).toBe(true);
      expect(startupSettings.algorithm).toBe('LEAST_LOADED');
      expect(startupSettings.maxOpenLeadsPerRep).toBe(25);
      expect(startupSettings.workingHoursOnly).toBe(true);
      expect(DistributionSettingsService.getCachedSettings()).toBeDefined();
    });
  });

  // =========================================================================
  // 6. Concurrency & Thundering Herd Protection
  // =========================================================================
  describe('6. Concurrency & Thundering Herd Protection', () => {
    it('coalesces simultaneous concurrent requests into a single DB query on cache miss', async () => {
      DistributionSettingsService.resetCache();

      // Launch 10 concurrent requests at the exact same millisecond
      const promises = Array.from({ length: 10 }, () => DistributionSettingsService.getSettings());
      const results = await Promise.all(promises);

      // All 10 returned identical accurate settings
      results.forEach((res) => {
        expect(res.enabled).toBe(true);
        expect(res.algorithm).toBe('LEAST_LOADED');
      });

      // Exactly 1 database query was made instead of 10
      expect(mockDb.from).toHaveBeenCalledTimes(1);
    });

    it('handles concurrent race condition: administrator disables auto-distribution while leads arrive concurrently', async () => {
      DistributionSettingsService.resetCache();
      const adminActor = { id: 1, role: 'ADMIN', name: 'Alik Admin' };

      // Simultaneously trigger lead arrivals and 1 admin disable request
      const lead1 = RoundRobinService.resolveAssignment(null, null);
      const disableOp = DistributionSettingsService.updateSettings({ enabled: false }, adminActor);
      const lead2 = RoundRobinService.resolveAssignment(null, null);
      const lead3 = RoundRobinService.resolveAssignment(null, null);

      const [res1, updateResult, res2, res3] = await Promise.all([lead1, disableOp, lead2, lead3]);

      expect(updateResult.enabled).toBe(false);

      // Subsequent lead assignment after confirmed disablement MUST be routed to POOL
      const subsequentLead = await RoundRobinService.resolveAssignment(null, null);
      expect(subsequentLead.responsible_user_id).toBeNull();
      expect(subsequentLead.assignment_type).toBe('POOL');
      expect(subsequentLead.reason).toContain('выключено руководителем');
    });
  });
});
