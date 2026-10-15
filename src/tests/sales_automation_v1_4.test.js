import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SalesPlanAlertsService } from '../modules/sales-plans/salesPlanAlerts.service.js';
import { SalesPlansService } from '../modules/sales-plans/salesPlans.service.js';
import { SalesPlansRepository } from '../modules/sales-plans/salesPlans.repository.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { updateAlertSettingsSchema } from '../modules/sales-plans/salesPlans.validator.js';

// Mock DB connection
vi.mock('../db/connection.js', () => ({
  getDB: vi.fn(),
  getServiceDB: vi.fn()
}));

import { getServiceDB } from '../db/connection.js';

describe('Sales Automation V1.4 — Automated Sales Plan Control Suite', () => {
  let mockSettings;
  let mockPlans;
  let mockPerformanceData;
  let mockManagementIds;
  let mockInsertedNotifications;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSettings = {
      id: 1,
      behind_schedule_threshold_pp: 15.0,
      at_risk_forecast_threshold_pct: 80.0,
      min_elapsed_working_days: 3,
      notify_achieved_enabled: true,
      weekly_digest_enabled: true,
      weekly_digest_day_of_week: 1, // Monday
      weekly_digest_hour: 9
    };

    mockManagementIds = [1, 2]; // Admin (1), Director (2)
    mockInsertedNotifications = [];

    // Mock SalesPlansRepository
    vi.spyOn(SalesPlansRepository, 'getAlertSettings').mockImplementation(async () => mockSettings);
    vi.spyOn(NotificationsRepository, 'getManagementUserIds').mockImplementation(async () => mockManagementIds);
    vi.spyOn(NotificationsRepository, 'createNotification').mockImplementation(async (payload) => {
      // Deduplicate by dedupe_key in mock
      const existing = mockInsertedNotifications.find(n => n.dedupe_key === payload.dedupe_key);
      if (existing) {
        return existing;
      }
      const newRecord = { id: mockInsertedNotifications.length + 1, ...payload };
      mockInsertedNotifications.push(newRecord);
      return newRecord;
    });
  });

  describe('1. Zero-Target Semantics (Requirement 5)', () => {
    it('requires BOTH targets to be met when deals and volume are positive', () => {
      // 10/10 deals, $90k/$100k volume -> NOT achieved
      const res1 = SalesPlanAlertsService.evaluateAchievementSemantics({
        targetDeals: 10,
        targetVolumeMinor: 10000000n,
        netDeals: 10,
        netVolumeMinor: 9000000n
      });
      expect(res1.isDealsAchieved).toBe(true);
      expect(res1.isVolumeAchieved).toBe(false);
      expect(res1.isOverallAchieved).toBe(false);

      // 9/10 deals, $110k/$100k volume -> NOT achieved
      const res2 = SalesPlanAlertsService.evaluateAchievementSemantics({
        targetDeals: 10,
        targetVolumeMinor: 10000000n,
        netDeals: 9,
        netVolumeMinor: 11000000n
      });
      expect(res2.isDealsAchieved).toBe(false);
      expect(res2.isVolumeAchieved).toBe(true);
      expect(res2.isOverallAchieved).toBe(false);

      // 10/10 deals, $100k/$100k volume -> ACHIEVED
      const res3 = SalesPlanAlertsService.evaluateAchievementSemantics({
        targetDeals: 10,
        targetVolumeMinor: 10000000n,
        netDeals: 10,
        netVolumeMinor: 10000000n
      });
      expect(res3.isDealsAchieved).toBe(true);
      expect(res3.isVolumeAchieved).toBe(true);
      expect(res3.isOverallAchieved).toBe(true);
    });

    it('requires only deals target when volume target is 0', () => {
      const res = SalesPlanAlertsService.evaluateAchievementSemantics({
        targetDeals: 5,
        targetVolumeMinor: 0n,
        netDeals: 5,
        netVolumeMinor: 0n
      });
      expect(res.hasDealsTarget).toBe(true);
      expect(res.hasVolumeTarget).toBe(false);
      expect(res.isDealsAchieved).toBe(true);
      expect(res.isVolumeAchieved).toBe(true);
      expect(res.isOverallAchieved).toBe(true);
    });

    it('requires only volume target when deals target is 0', () => {
      const res = SalesPlanAlertsService.evaluateAchievementSemantics({
        targetDeals: 0,
        targetVolumeMinor: 5000000n,
        netDeals: 0,
        netVolumeMinor: 5500000n
      });
      expect(res.hasDealsTarget).toBe(false);
      expect(res.hasVolumeTarget).toBe(true);
      expect(res.isDealsAchieved).toBe(true);
      expect(res.isVolumeAchieved).toBe(true);
      expect(res.isOverallAchieved).toBe(true);
    });

    it('returns isOverallAchieved = false when both targets are 0 (unconfigured plan)', () => {
      const res = SalesPlanAlertsService.evaluateAchievementSemantics({
        targetDeals: 0,
        targetVolumeMinor: 0n,
        netDeals: 2,
        netVolumeMinor: 2000000n
      });
      expect(res.hasDealsTarget).toBe(false);
      expect(res.hasVolumeTarget).toBe(false);
      expect(res.isOverallAchieved).toBe(false);
    });
  });

  describe('2. Grace Period & Absence of Plans (Requirements 6 & 7)', () => {
    it('suppresses forecast and behind-schedule alerts when elapsedWorkingDays < 3', async () => {
      // Mock pacing with 2 working days elapsed (< min_elapsed_working_days = 3)
      vi.spyOn(SalesPlansService, 'calculateWorkingDaysPacing').mockReturnValue({
        period: '2026-10',
        totalWorkingDays: 26,
        elapsedWorkingDays: 2,
        remainingWorkingDays: 24,
        pacingPercent: 7.7,
        hasSufficientDataForForecast: false
      });

      mockPlans = [
        {
          id: 101,
          period: '2026-10',
          scope_type: 'DEPARTMENT',
          target_deals_count: 20,
          target_volume_minor: 20000000n,
          status: 'APPROVED',
          approved_at: '2026-10-01T08:00:00Z'
        }
      ];
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue(mockPlans);

      // Even with 0 deals, in grace period no BEHIND_SCHEDULE or AT_RISK alerts are generated
      mockPerformanceData = {
        period: '2026-10',
        department: {
          gross: { count: 0, volumeMinor: 0 },
          cancellations: { totalCount: 0, totalVolumeMinor: 0 },
          net: { count: 0, volumeMinor: 0, volumeUsd: 0 },
          target: { dealsCount: 20, volumeMinor: 20000000, volumeUsd: 200000, status: 'APPROVED' },
          execution: { dealsPercent: 0, volumePercent: 0, pacingPaceDifference: -7.7 },
          forecast: { status: 'INSUFFICIENT_DATA', deals: 0, volumeMinor: 0 },
          cashCollected: { volumeUsd: 0 }
        },
        managers: [],
        buildings: []
      };
      vi.spyOn(SalesPlansService, 'getPerformanceData').mockResolvedValue(mockPerformanceData);

      const stats = await SalesPlanAlertsService.evaluateSalesPlansAlerts({
        period: '2026-10',
        businessDate: '2026-10-03'
      });

      expect(stats.suppressedGracePeriodCount).toBe(1);
      expect(stats.behindScheduleNotified).toBe(0);
      expect(stats.atRiskNotified).toBe(0);
      expect(mockInsertedNotifications.length).toBe(0);
    });

    it('suppresses unapproved or DRAFT plans completely (Requirement 6)', async () => {
      vi.spyOn(SalesPlansService, 'calculateWorkingDaysPacing').mockReturnValue({
        period: '2026-10',
        totalWorkingDays: 26,
        elapsedWorkingDays: 10,
        remainingWorkingDays: 16,
        pacingPercent: 38.5,
        hasSufficientDataForForecast: true
      });

      // Plans in DRAFT status
      mockPlans = [
        {
          id: 102,
          period: '2026-10',
          scope_type: 'DEPARTMENT',
          target_deals_count: 25,
          target_volume_minor: 25000000n,
          status: 'DRAFT'
        }
      ];
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue(mockPlans);

      const stats = await SalesPlanAlertsService.evaluateSalesPlansAlerts({
        period: '2026-10',
        businessDate: '2026-10-12'
      });

      expect(stats.approvedPlansCount).toBe(0);
      expect(stats.suppressedDraftCount).toBe(1);
      expect(mockInsertedNotifications.length).toBe(0);
    });
  });

  describe('3. Pacing & Risk Alerts Evaluation (Events 1 & 2)', () => {
    beforeEach(() => {
      // Day 12 of 26 -> pacing is ~46.2%
      vi.spyOn(SalesPlansService, 'calculateWorkingDaysPacing').mockReturnValue({
        period: '2026-10',
        totalWorkingDays: 26,
        elapsedWorkingDays: 12,
        remainingWorkingDays: 14,
        pacingPercent: 46.2,
        hasSufficientDataForForecast: true
      });
    });

    it('generates SALES_PLAN_BEHIND_SCHEDULE when fact lags by >= 15 percentage points', async () => {
      mockPlans = [
        {
          id: 103,
          period: '2026-10',
          scope_type: 'DEPARTMENT',
          target_deals_count: 20,
          target_volume_minor: 20000000n,
          status: 'APPROVED',
          approved_at: '2026-10-01T08:00:00Z'
        }
      ];
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue(mockPlans);

      // Fact is 4 deals (20.0%), pacing is 46.2% -> pacing gap is -26.2% (exceeds 15% threshold)
      mockPerformanceData = {
        period: '2026-10',
        department: {
          gross: { count: 4, volumeMinor: 4000000 },
          cancellations: { totalCount: 0, totalVolumeMinor: 0 },
          net: { count: 4, volumeMinor: 4000000, volumeUsd: 40000 },
          target: { dealsCount: 20, volumeMinor: 20000000, volumeUsd: 200000, status: 'APPROVED' },
          execution: { dealsPercent: 20.0, volumePercent: 20.0, pacingPaceDifference: -26.2 },
          forecast: { status: 'BEHIND', deals: 9, volumeMinor: 9000000 },
          cashCollected: { volumeUsd: 35000 }
        },
        managers: [],
        buildings: []
      };
      vi.spyOn(SalesPlansService, 'getPerformanceData').mockResolvedValue(mockPerformanceData);

      const stats = await SalesPlanAlertsService.evaluateSalesPlansAlerts({
        period: '2026-10',
        businessDate: '2026-10-15'
      });

      expect(stats.behindScheduleNotified).toBeGreaterThan(0);
      const behindAlert = mockInsertedNotifications.find(n => n.event_type === 'SALES_PLAN_BEHIND_SCHEDULE');
      expect(behindAlert).toBeDefined();
      expect(behindAlert.metadata.pacing_gap_pp).toBeCloseTo(26.2, 1);
    });

    it('handles negative Net (cancellations > gross) without division by zero', async () => {
      mockPlans = [
        {
          id: 104,
          period: '2026-10',
          scope_type: 'DEPARTMENT',
          target_deals_count: 20,
          target_volume_minor: 20000000n,
          status: 'APPROVED',
          approved_at: '2026-10-01T08:00:00Z'
        }
      ];
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue(mockPlans);

      // Gross = 1, Cancellations = 3 -> Net = -2 deals
      mockPerformanceData = {
        period: '2026-10',
        department: {
          gross: { count: 1, volumeMinor: 1000000 },
          cancellations: { totalCount: 3, totalVolumeMinor: 3000000 },
          net: { count: -2, volumeMinor: -2000000, volumeUsd: -20000 },
          target: { dealsCount: 20, volumeMinor: 20000000, volumeUsd: 200000, status: 'APPROVED' },
          execution: { dealsPercent: -10.0, volumePercent: -10.0, pacingPaceDifference: -56.2 },
          forecast: { status: 'BEHIND', deals: -4, volumeMinor: -4000000 },
          cashCollected: { volumeUsd: 0 }
        },
        managers: [],
        buildings: []
      };
      vi.spyOn(SalesPlansService, 'getPerformanceData').mockResolvedValue(mockPerformanceData);

      const stats = await SalesPlanAlertsService.evaluateSalesPlansAlerts({
        period: '2026-10',
        businessDate: '2026-10-15'
      });

      expect(stats.atRiskNotified).toBeGreaterThan(0);
      const riskAlert = mockInsertedNotifications.find(n => n.event_type === 'SALES_PLAN_AT_RISK');
      expect(riskAlert).toBeDefined();
      expect(riskAlert.metadata.has_negative_net).toBe(true);
      expect(riskAlert.message).toContain('отрицательный баланс продаж');
    });
  });

  describe('4. Achievement & Deduplication (Events 3 & Idempotency)', () => {
    it('generates SALES_PLAN_ACHIEVED when 100%+ target is reached', async () => {
      vi.spyOn(SalesPlansService, 'calculateWorkingDaysPacing').mockReturnValue({
        period: '2026-10',
        totalWorkingDays: 26,
        elapsedWorkingDays: 20,
        remainingWorkingDays: 6,
        pacingPercent: 76.9,
        hasSufficientDataForForecast: true
      });

      mockPlans = [
        {
          id: 105,
          period: '2026-10',
          scope_type: 'MANAGER',
          manager_id: 3,
          target_deals_count: 5,
          target_volume_minor: 5000000n,
          status: 'APPROVED',
          approved_at: '2026-10-01T08:00:00Z'
        }
      ];
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue(mockPlans);

      // Manager 3: 6 deals (120%), $65k (130%) -> Achieved
      mockPerformanceData = {
        period: '2026-10',
        department: null,
        managers: [
          {
            manager: { id: 3, name: 'Dadojon Saidov', role: 'SALES_MANAGER' },
            metrics: {
              gross: { count: 6, volumeMinor: 6500000 },
              cancellations: { totalCount: 0, totalVolumeMinor: 0 },
              net: { count: 6, volumeMinor: 6500000, volumeUsd: 65000 },
              target: { dealsCount: 5, volumeMinor: 5000000, status: 'APPROVED' },
              execution: { dealsPercent: 120.0, volumePercent: 130.0, pacingPaceDifference: 43.1 },
              forecast: { status: 'EXCEEDED', deals: 8 }
            }
          }
        ],
        buildings: []
      };
      vi.spyOn(SalesPlansService, 'getPerformanceData').mockResolvedValue(mockPerformanceData);

      const stats = await SalesPlanAlertsService.evaluateSalesPlansAlerts({
        period: '2026-10',
        businessDate: '2026-10-22'
      });

      expect(stats.achievedNotified).toBeGreaterThan(0);
      const achievedAlert = mockInsertedNotifications.find(n => n.event_type === 'SALES_PLAN_ACHIEVED');
      expect(achievedAlert).toBeDefined();
      expect(achievedAlert.title).toContain('План продаж выполнен');
    });

    it('enforces idempotency on repeated Cron runs via dedupe_key', async () => {
      vi.spyOn(SalesPlansService, 'calculateWorkingDaysPacing').mockReturnValue({
        period: '2026-10',
        totalWorkingDays: 26,
        elapsedWorkingDays: 15,
        remainingWorkingDays: 11,
        pacingPercent: 57.7,
        hasSufficientDataForForecast: true
      });

      mockPlans = [
        {
          id: 106,
          period: '2026-10',
          scope_type: 'DEPARTMENT',
          target_deals_count: 10,
          target_volume_minor: 10000000n,
          status: 'APPROVED',
          approved_at: '2026-10-01T08:00:00Z'
        }
      ];
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue(mockPlans);

      mockPerformanceData = {
        period: '2026-10',
        department: {
          gross: { count: 10, volumeMinor: 10000000 },
          cancellations: { totalCount: 0, totalVolumeMinor: 0 },
          net: { count: 10, volumeMinor: 10000000, volumeUsd: 100000 },
          target: { dealsCount: 10, volumeMinor: 10000000, status: 'APPROVED' },
          execution: { dealsPercent: 100.0, volumePercent: 100.0, pacingPaceDifference: 42.3 },
          forecast: { status: 'EXCEEDED', deals: 10 },
          cashCollected: { volumeUsd: 50000 }
        },
        managers: [],
        buildings: []
      };
      vi.spyOn(SalesPlansService, 'getPerformanceData').mockResolvedValue(mockPerformanceData);

      // Run 1: 09:00
      await SalesPlanAlertsService.evaluateSalesPlansAlerts({ period: '2026-10', businessDate: '2026-10-18' });
      const countAfterRun1 = mockInsertedNotifications.length;
      expect(countAfterRun1).toBe(2); // Sent to Admin (1) and Director (2)

      // Run 2: 09:30 (repeated Cron run)
      await SalesPlanAlertsService.evaluateSalesPlansAlerts({ period: '2026-10', businessDate: '2026-10-18' });
      const countAfterRun2 = mockInsertedNotifications.length;
      // Count must NOT increase because dedupe_key prevents duplicates!
      expect(countAfterRun2).toBe(countAfterRun1);
    });

    it('allows re-triggering SALES_PLAN_ACHIEVED when plan is modified to a new version', async () => {
      vi.spyOn(SalesPlansService, 'calculateWorkingDaysPacing').mockReturnValue({
        period: '2026-10',
        totalWorkingDays: 26,
        elapsedWorkingDays: 15,
        remainingWorkingDays: 11,
        pacingPercent: 57.7,
        hasSufficientDataForForecast: true
      });

      // Initial version v1
      const planV1 = {
        id: 107,
        period: '2026-10',
        scope_type: 'DEPARTMENT',
        target_deals_count: 5,
        target_volume_minor: 5000000n,
        status: 'APPROVED',
        approved_at: '2026-10-01T08:00:00Z'
      };
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue([planV1]);

      mockPerformanceData = {
        period: '2026-10',
        department: {
          gross: { count: 6, volumeMinor: 6000000 },
          cancellations: { totalCount: 0, totalVolumeMinor: 0 },
          net: { count: 6, volumeMinor: 6000000, volumeUsd: 60000 },
          target: { dealsCount: 5, volumeMinor: 5000000, status: 'APPROVED' },
          execution: { dealsPercent: 120.0, volumePercent: 120.0 },
          forecast: { status: 'EXCEEDED', deals: 8 }
        },
        managers: [],
        buildings: []
      };
      vi.spyOn(SalesPlansService, 'getPerformanceData').mockResolvedValue(mockPerformanceData);

      await SalesPlanAlertsService.evaluateSalesPlansAlerts({ period: '2026-10', businessDate: '2026-10-18' });
      expect(mockInsertedNotifications.length).toBe(2);

      // Now target is raised to 10 deals, approved at a new timestamp
      const planV2 = {
        id: 107,
        period: '2026-10',
        scope_type: 'DEPARTMENT',
        target_deals_count: 10,
        target_volume_minor: 10000000n,
        status: 'APPROVED',
        approved_at: '2026-10-19T10:00:00Z' // new version
      };
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue([planV2]);

      // Later, deals reach 11 deals
      mockPerformanceData.department.gross.count = 11;
      mockPerformanceData.department.net.count = 11;
      mockPerformanceData.department.net.volumeMinor = 11000000;
      mockPerformanceData.department.target.dealsCount = 10;
      mockPerformanceData.department.target.volumeMinor = 10000000;

      await SalesPlanAlertsService.evaluateSalesPlansAlerts({ period: '2026-10', businessDate: '2026-10-25' });
      // New notifications are created because planVersion timestamp changed!
      expect(mockInsertedNotifications.length).toBe(4);
    });
  });

  describe('5. Strict RBAC & Data Leakage Prevention (Requirement 8)', () => {
    it('sends manager plan alerts strictly to that manager and management, NOT to colleagues', async () => {
      vi.spyOn(SalesPlansService, 'calculateWorkingDaysPacing').mockReturnValue({
        period: '2026-10',
        totalWorkingDays: 26,
        elapsedWorkingDays: 10,
        remainingWorkingDays: 16,
        pacingPercent: 38.5,
        hasSufficientDataForForecast: true
      });

      // Plan for Manager 3 (Dadojon Saidov)
      mockPlans = [
        {
          id: 108,
          period: '2026-10',
          scope_type: 'MANAGER',
          manager_id: 3,
          target_deals_count: 10,
          target_volume_minor: 10000000n,
          status: 'APPROVED',
          approved_at: '2026-10-01T08:00:00Z'
        }
      ];
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue(mockPlans);

      // Manager 3 is behind schedule: 1 deal (10.0%), pacing 38.5% -> gap -28.5%
      mockPerformanceData = {
        period: '2026-10',
        department: null,
        managers: [
          {
            manager: { id: 3, name: 'Dadojon Saidov', role: 'SALES_MANAGER' },
            metrics: {
              gross: { count: 1, volumeMinor: 1000000 },
              cancellations: { totalCount: 0, totalVolumeMinor: 0 },
              net: { count: 1, volumeMinor: 1000000, volumeUsd: 10000 },
              target: { dealsCount: 10, volumeMinor: 10000000, status: 'APPROVED' },
              execution: { dealsPercent: 10.0, volumePercent: 10.0, pacingPaceDifference: -28.5 },
              forecast: { status: 'BEHIND', deals: 3, volumeMinor: 3000000 }
            }
          },
          {
            manager: { id: 4, name: 'Alisher Rahimov', role: 'SALES_MANAGER' }, // Colleague
            metrics: {
              gross: { count: 5, volumeMinor: 5000000 },
              cancellations: { totalCount: 0, totalVolumeMinor: 0 },
              net: { count: 5, volumeMinor: 5000000, volumeUsd: 50000 },
              target: { dealsCount: 10, volumeMinor: 10000000, status: 'APPROVED' },
              execution: { dealsPercent: 50.0, volumePercent: 50.0, pacingPaceDifference: 11.5 },
              forecast: { status: 'ON_TRACK', deals: 10 }
            }
          }
        ],
        buildings: []
      };
      vi.spyOn(SalesPlansService, 'getPerformanceData').mockResolvedValue(mockPerformanceData);

      await SalesPlanAlertsService.evaluateSalesPlansAlerts({
        period: '2026-10',
        businessDate: '2026-10-12'
      });

      const recipientIds = mockInsertedNotifications.map(n => n.user_id);
      // Must contain Admin (1), Director (2), and Manager 3
      expect(recipientIds).toContain(1);
      expect(recipientIds).toContain(2);
      expect(recipientIds).toContain(3);
      // MUST NOT contain Manager 4 (Alisher Rahimov) - zero data leakage!
      expect(recipientIds).not.toContain(4);
      // MUST NOT contain Finance Manager (5)
      expect(recipientIds).not.toContain(5);
    });
  });

  describe('6. Weekly Digest (Event 4)', () => {
    it('generates weekly digest for management on Monday morning with forceWeeklyDigest', async () => {
      vi.spyOn(SalesPlansService, 'calculateWorkingDaysPacing').mockReturnValue({
        period: '2026-10',
        totalWorkingDays: 26,
        elapsedWorkingDays: 12,
        remainingWorkingDays: 14,
        pacingPercent: 46.2,
        hasSufficientDataForForecast: true
      });

      mockPlans = [
        {
          id: 109,
          period: '2026-10',
          scope_type: 'DEPARTMENT',
          target_deals_count: 20,
          target_volume_minor: 20000000n,
          status: 'APPROVED',
          approved_at: '2026-10-01T08:00:00Z'
        }
      ];
      vi.spyOn(SalesPlansRepository, 'getPlansByPeriod').mockResolvedValue(mockPlans);

      mockPerformanceData = {
        period: '2026-10',
        department: {
          gross: { count: 12, volumeMinor: 12000000 },
          cancellations: { totalCount: 1, totalVolumeMinor: 1000000 },
          net: { count: 11, volumeMinor: 11000000, volumeUsd: 110000 },
          target: { dealsCount: 20, volumeMinor: 20000000, volumeUsd: 200000, status: 'APPROVED' },
          execution: { dealsPercent: 55.0, volumePercent: 55.0 },
          forecast: { deals: 23, status: 'ON_TRACK' },
          cashCollected: { volumeUsd: 85000 }
        },
        managers: [
          {
            manager: { id: 3, name: 'Dadojon Saidov' },
            metrics: { execution: { pacingPaceDifference: -18.5 } }
          }
        ],
        buildings: []
      };
      vi.spyOn(SalesPlansService, 'getPerformanceData').mockResolvedValue(mockPerformanceData);

      const stats = await SalesPlanAlertsService.evaluateSalesPlansAlerts({
        period: '2026-10',
        businessDate: '2026-10-19',
        forceWeeklyDigest: true
      });

      expect(stats.weeklyDigestNotified).toBeGreaterThan(0);
      const digestAlert = mockInsertedNotifications.find(n => n.event_type === 'SALES_PLAN_WEEKLY_DIGEST');
      expect(digestAlert).toBeDefined();
      expect(digestAlert.title).toContain('Еженедельный дайджест');
      expect(digestAlert.message).toContain('Dadojon Saidov');
      expect(digestAlert.message).toContain('Касса: $85,000.00');
    });
  });

  describe('7. Threshold Validator Schema', () => {
    it('validates configurable alert thresholds with boundary checks', () => {
      // Valid input
      const valid = updateAlertSettingsSchema.safeParse({
        behind_schedule_threshold_pp: 15.0,
        at_risk_forecast_threshold_pct: 80.0,
        min_elapsed_working_days: 3,
        notify_achieved_enabled: true,
        weekly_digest_enabled: true
      });
      expect(valid.success).toBe(true);

      // Invalid threshold: behind_schedule < 1.0
      const invalidBehind = updateAlertSettingsSchema.safeParse({
        behind_schedule_threshold_pp: 0.5,
        at_risk_forecast_threshold_pct: 80.0,
        min_elapsed_working_days: 3
      });
      expect(invalidBehind.success).toBe(false);

      // Invalid threshold: at_risk > 99.0
      const invalidRisk = updateAlertSettingsSchema.safeParse({
        behind_schedule_threshold_pp: 15.0,
        at_risk_forecast_threshold_pct: 100.0,
        min_elapsed_working_days: 3
      });
      expect(invalidRisk.success).toBe(false);

      // Invalid min_elapsed_working_days < 0
      const invalidGrace = updateAlertSettingsSchema.safeParse({
        behind_schedule_threshold_pp: 15.0,
        at_risk_forecast_threshold_pct: 80.0,
        min_elapsed_working_days: -1
      });
      expect(invalidGrace.success).toBe(false);
    });
  });
});
