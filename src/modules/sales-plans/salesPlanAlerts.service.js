import { getServiceDB } from '../../db/connection.js';
import { getBusinessDate, getBusinessDateTime } from '../../utils/businessTime.js';
import { SalesPlansRepository } from './salesPlans.repository.js';
import { SalesPlansService } from './salesPlans.service.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class SalesPlanAlertsService {
  /**
   * Helper to compute ISO week number
   */
  static getIsoWeekNumber(d) {
    const target = new Date(d.valueOf());
    const dayNr = (d.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
      target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
    }
    return 1 + Math.ceil((firstThursday - target) / 604800000);
  }

  /**
   * Evaluate zero-target semantics for achievement
   * - Both targets positive: both must be >= 100%
   * - Deals > 0, Volume == 0: only deals count must be >= 100%
   * - Volume > 0, Deals == 0: only volume must be >= 100%
   * - Both 0: not configured, cannot be achieved
   */
  static evaluateAchievementSemantics({ targetDeals, targetVolumeMinor, netDeals, netVolumeMinor }) {
    const hasDealsTarget = targetDeals > 0;
    const hasVolumeTarget = targetVolumeMinor > 0n;

    let isDealsAchieved = false;
    let isVolumeAchieved = false;
    let isOverallAchieved = false;

    if (hasDealsTarget && hasVolumeTarget) {
      isDealsAchieved = netDeals >= targetDeals;
      isVolumeAchieved = netVolumeMinor >= targetVolumeMinor;
      isOverallAchieved = isDealsAchieved && isVolumeAchieved;
    } else if (hasDealsTarget && !hasVolumeTarget) {
      isDealsAchieved = netDeals >= targetDeals;
      isVolumeAchieved = true;
      isOverallAchieved = isDealsAchieved;
    } else if (!hasDealsTarget && hasVolumeTarget) {
      isDealsAchieved = true;
      isVolumeAchieved = netVolumeMinor >= targetVolumeMinor;
      isOverallAchieved = isVolumeAchieved;
    } else {
      isDealsAchieved = false;
      isVolumeAchieved = false;
      isOverallAchieved = false;
    }

    const dealsPercent = hasDealsTarget
      ? Number(((netDeals / targetDeals) * 100).toFixed(1))
      : 0;

    const volumePercent = hasVolumeTarget
      ? Number(((Number(netVolumeMinor) / Number(targetVolumeMinor)) * 100).toFixed(1))
      : 0;

    return {
      hasDealsTarget,
      hasVolumeTarget,
      isDealsAchieved,
      isVolumeAchieved,
      isOverallAchieved,
      dealsPercent,
      volumePercent
    };
  }

  /**
   * Main evaluation cycle for Sales Automation V1.4
   */
  static async evaluateSalesPlansAlerts({
    period = null,
    businessDate = null,
    isDryRun = false,
    forceWeeklyDigest = false
  } = {}) {
    const effectiveDate = businessDate || getBusinessDate();
    const effectivePeriod = period || effectiveDate.substring(0, 7);

    const stats = {
      period: effectivePeriod,
      businessDate: effectiveDate,
      isDryRun,
      plansScanned: 0,
      approvedPlansCount: 0,
      behindScheduleNotified: 0,
      atRiskNotified: 0,
      achievedNotified: 0,
      weeklyDigestNotified: 0,
      suppressedGracePeriodCount: 0,
      suppressedDraftCount: 0,
      notificationsCreated: []
    };

    // 1. Load Alert Settings
    const settings = await SalesPlansRepository.getAlertSettings();

    // 2. Load Pacing for the period
    const pacing = SalesPlansService.calculateWorkingDaysPacing(effectivePeriod);

    // 3. Grace period check: first N working days suppress forecast-based alerts
    const isGracePeriodActive = pacing.elapsedWorkingDays < settings.min_elapsed_working_days;

    // 4. Fetch all sales plans for the period
    const allPlans = await SalesPlansRepository.getPlansByPeriod(effectivePeriod);
    stats.plansScanned = allPlans.length;

    // 5. Strict Draft Suppression: Only APPROVED or ACTIVE_LOCKED plans are controlled
    const approvedPlans = allPlans.filter(p => p.status === 'APPROVED' || p.status === 'ACTIVE_LOCKED');
    stats.approvedPlansCount = approvedPlans.length;
    stats.suppressedDraftCount = allPlans.length - approvedPlans.length;

    if (approvedPlans.length === 0) {
      return stats;
    }

    // 6. Fetch performance data with admin role for full company evaluation
    const performanceData = await SalesPlansService.getPerformanceData(
      { period: effectivePeriod },
      { role: 'ADMIN' }
    );

    // Get management recipients (ADMIN and DIRECTOR)
    const managementUserIds = await NotificationsRepository.getManagementUserIds();

    // Map metrics for each plan by scope
    for (const plan of approvedPlans) {
      let planMetrics = null;
      let scopeTitle = '';
      let targetManagerId = null;

      if (plan.scope_type === 'DEPARTMENT') {
        planMetrics = performanceData.department;
        scopeTitle = 'Отдел продаж (Компания)';
      } else if (plan.scope_type === 'MANAGER' && plan.manager_id) {
        targetManagerId = Number(plan.manager_id);
        const mgrEntry = (performanceData.managers || []).find(m => Number(m.manager.id) === targetManagerId);
        planMetrics = mgrEntry ? mgrEntry.metrics : null;
        scopeTitle = mgrEntry ? `Менеджер ${mgrEntry.manager.name}` : `Менеджер #${targetManagerId}`;
      } else if (plan.scope_type === 'BUILDING' && plan.building_id) {
        const bldEntry = (performanceData.buildings || []).find(b => Number(b.building.id) === Number(plan.building_id));
        planMetrics = bldEntry ? bldEntry.metrics : null;
        scopeTitle = bldEntry ? `Корпус ${bldEntry.building.name}` : `Корпус #${plan.building_id}`;
      } else if (plan.scope_type === 'PROJECT' && plan.project_id) {
        // Project metrics aggregate all buildings of that project
        scopeTitle = `ЖК #${plan.project_id}`;
      }

      if (!planMetrics) continue;

      const targetDeals = Number(plan.target_deals_count || 0);
      const targetVolumeMinor = BigInt(plan.target_volume_minor || 0);
      const netDeals = Number(planMetrics.net.count || 0);
      const netVolumeMinor = BigInt(planMetrics.net.volumeMinor || 0);

      // Check achievement semantics
      const achievement = this.evaluateAchievementSemantics({
        targetDeals,
        targetVolumeMinor,
        netDeals,
        netVolumeMinor
      });

      // Check negative Net (cancellations exceed gross sales)
      const hasNegativeNet = netDeals < 0 || netVolumeMinor < 0n;

      // Resolve Recipient IDs with strict RBAC isolation:
      // - If MANAGER plan: manager themselves + management (ADMIN, DIRECTOR). Colleagues excluded!
      // - If DEPARTMENT / BUILDING / PROJECT: strictly management (ADMIN, DIRECTOR).
      let recipientUserIds = [];
      if (plan.scope_type === 'MANAGER' && targetManagerId) {
        recipientUserIds = Array.from(new Set([targetManagerId, ...managementUserIds]));
      } else {
        recipientUserIds = [...managementUserIds];
      }

      // Action URL for deep linking
      const actionUrl = `/leads?tab=sales-plan&period=${effectivePeriod}&scope=${plan.scope_type}${plan.manager_id ? `&managerId=${plan.manager_id}` : ''}${plan.building_id ? `&buildingId=${plan.building_id}` : ''}`;

      // -------------------------------------------------------------
      // EVENT 1: SALES_PLAN_ACHIEVED (100%+ Plan Met)
      // -------------------------------------------------------------
      if (achievement.isOverallAchieved && settings.notify_achieved_enabled) {
        const planVersion = plan.approved_at || plan.updated_at || 'v1';
        const netVolumeUsdStr = Number(Number(netVolumeMinor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
        const summaryText = achievement.hasDealsTarget && achievement.hasVolumeTarget
          ? `Сделки: ${achievement.dealsPercent}% (${netDeals}/${targetDeals}), Объем: ${achievement.volumePercent}% ($${netVolumeUsdStr})`
          : (achievement.hasDealsTarget
              ? `Сделки: ${achievement.dealsPercent}% (${netDeals}/${targetDeals})`
              : `Объем: ${achievement.volumePercent}% ($${netVolumeUsdStr})`);

        for (const userId of recipientUserIds) {
          const dedupeKey = `SALES_PLAN_ACHIEVED:${plan.id}:${userId}:${effectivePeriod}:${planVersion}`;
          const notifPayload = {
            user_id: userId,
            event_type: 'SALES_PLAN_ACHIEVED',
            type: 'SALES_PLAN_ACHIEVED',
            title: `🎯 План продаж выполнен: ${scopeTitle}`,
            message: `Поздравляем! План «${scopeTitle}» на ${effectivePeriod} успешно выполнен! ${summaryText}.`,
            entity_type: 'SALES_PLAN',
            entity_id: plan.id,
            action_url: actionUrl,
            dedupe_key: dedupeKey,
            metadata: {
              plan_id: plan.id,
              period: effectivePeriod,
              scope_type: plan.scope_type,
              target_deals: targetDeals,
              net_deals: netDeals,
              target_volume_minor: Number(targetVolumeMinor),
              net_volume_minor: Number(netVolumeMinor),
              deals_percent: achievement.dealsPercent,
              volume_percent: achievement.volumePercent
            }
          };

          stats.achievedNotified++;
          stats.notificationsCreated.push({ dedupeKey, userId, eventType: 'SALES_PLAN_ACHIEVED' });

          if (!isDryRun) {
            await NotificationsRepository.createNotification(notifPayload);
          }
        }
      }

      // If already achieved, skip warning alerts
      if (achievement.isOverallAchieved) {
        continue;
      }

      // -------------------------------------------------------------
      // GRACE PERIOD SUPPRESSION FOR FORECAST ALERTS
      // -------------------------------------------------------------
      if (isGracePeriodActive) {
        stats.suppressedGracePeriodCount++;
        continue;
      }

      // Primary execution % for comparison with pacing
      const primaryExecutionPercent = achievement.hasDealsTarget
        ? achievement.dealsPercent
        : (achievement.hasVolumeTarget ? achievement.volumePercent : 0);

      const pacingGap = primaryExecutionPercent - pacing.pacingPercent;

      // -------------------------------------------------------------
      // EVENT 2: SALES_PLAN_BEHIND_SCHEDULE
      // -------------------------------------------------------------
      if (pacingGap <= -settings.behind_schedule_threshold_pp) {
        const gapAbs = Math.abs(pacingGap).toFixed(1);

        for (const userId of recipientUserIds) {
          const dedupeKey = `SALES_PLAN_BEHIND_SCHEDULE:${plan.id}:${userId}:${effectivePeriod}:${effectiveDate}`;
          const notifPayload = {
            user_id: userId,
            event_type: 'SALES_PLAN_BEHIND_SCHEDULE',
            type: 'SALES_PLAN_BEHIND_SCHEDULE',
            title: `Отставание от темпа продаж: ${scopeTitle}`,
            message: `По плану «${scopeTitle}» на ${effectivePeriod} зафиксировано отставание от календарного темпа на ${gapAbs}% (факт: ${primaryExecutionPercent}%, норматив темпа: ${pacing.pacingPercent}%). Необходима активизация сделок.`,
            entity_type: 'SALES_PLAN',
            entity_id: plan.id,
            action_url: actionUrl,
            dedupe_key: dedupeKey,
            metadata: {
              plan_id: plan.id,
              period: effectivePeriod,
              scope_type: plan.scope_type,
              pacing_gap_pp: Number(gapAbs),
              fact_percent: primaryExecutionPercent,
              pacing_percent: pacing.pacingPercent,
              business_date: effectiveDate
            }
          };

          stats.behindScheduleNotified++;
          stats.notificationsCreated.push({ dedupeKey, userId, eventType: 'SALES_PLAN_BEHIND_SCHEDULE' });

          if (!isDryRun) {
            await NotificationsRepository.createNotification(notifPayload);
          }
        }
      }

      // -------------------------------------------------------------
      // EVENT 3: SALES_PLAN_AT_RISK
      // -------------------------------------------------------------
      const forecastDeals = Number(planMetrics.forecast?.deals ?? netDeals);
      const forecastVolumeMinor = BigInt(planMetrics.forecast?.volumeMinor ?? Number(netVolumeMinor));

      let forecastPercent = 0;
      if (achievement.hasDealsTarget && targetDeals > 0) {
        forecastPercent = Number(((forecastDeals / targetDeals) * 100).toFixed(1));
      } else if (achievement.hasVolumeTarget && targetVolumeMinor > 0n) {
        forecastPercent = Number(((Number(forecastVolumeMinor) / Number(targetVolumeMinor)) * 100).toFixed(1));
      }

      const isAtRisk = hasNegativeNet || (forecastPercent < settings.at_risk_forecast_threshold_pct);

      if (isAtRisk) {
        let riskMessage = '';
        if (hasNegativeNet) {
          riskMessage = `Критический риск по плану «${scopeTitle}»: отрицательный баланс продаж (${netDeals} сделок) из-за расторжения договоров. Прогноз не сформирован.`;
        } else {
          const deviation = forecastDeals - targetDeals;
          riskMessage = `Высокий риск невыполнения плана «${scopeTitle}»: прогноз закрытия месяца составляет ${forecastPercent}% (прогноз: ${forecastDeals} из ${targetDeals} сделок, отклонение: ${deviation} сделок).`;
        }

        for (const userId of recipientUserIds) {
          const dedupeKey = `SALES_PLAN_AT_RISK:${plan.id}:${userId}:${effectivePeriod}:${effectiveDate}`;
          const notifPayload = {
            user_id: userId,
            event_type: 'SALES_PLAN_AT_RISK',
            type: 'SALES_PLAN_AT_RISK',
            title: `⚠️ Риск невыполнения плана продаж: ${scopeTitle}`,
            message: riskMessage,
            entity_type: 'SALES_PLAN',
            entity_id: plan.id,
            action_url: actionUrl,
            dedupe_key: dedupeKey,
            metadata: {
              plan_id: plan.id,
              period: effectivePeriod,
              scope_type: plan.scope_type,
              forecast_deals: forecastDeals,
              target_deals: targetDeals,
              forecast_percent: forecastPercent,
              has_negative_net: hasNegativeNet,
              business_date: effectiveDate
            }
          };

          stats.atRiskNotified++;
          stats.notificationsCreated.push({ dedupeKey, userId, eventType: 'SALES_PLAN_AT_RISK' });

          if (!isDryRun) {
            await NotificationsRepository.createNotification(notifPayload);
          }
        }
      }
    }

    // -------------------------------------------------------------
    // EVENT 4: SALES_PLAN_WEEKLY_DIGEST (Monday 09:00 Asia/Dushanbe)
    // -------------------------------------------------------------
    const bdt = getBusinessDateTime();
    const currentHour = parseInt(bdt.timeStr.split(':')[0], 10);
    const localDate = new Date(`${bdt.dateStr}T12:00:00Z`);
    const dayOfWeek = localDate.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat

    const isWeeklyDigestDue = forceWeeklyDigest || (
      settings.weekly_digest_enabled &&
      dayOfWeek === settings.weekly_digest_day_of_week &&
      currentHour === settings.weekly_digest_hour
    );

    if (isWeeklyDigestDue && performanceData.department) {
      const dept = performanceData.department;
      const deptTarget = dept.target || {};
      const netDeals = dept.net?.count || 0;
      const targetDeals = deptTarget.dealsCount || 0;
      const netVolUsd = (dept.net?.volumeUsd || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
      const cashUsd = (dept.cashCollected?.volumeUsd || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
      const factPercent = dept.execution?.dealsPercent || 0;
      const forecastPercent = dept.forecast?.deals && targetDeals > 0
        ? Number(((dept.forecast.deals / targetDeals) * 100).toFixed(1))
        : 0;

      // Identify top lagging managers
      const laggingManagers = (performanceData.managers || [])
        .filter(m => (m.metrics.execution?.pacingPaceDifference || 0) < 0)
        .sort((a, b) => (a.metrics.execution?.pacingPaceDifference || 0) - (b.metrics.execution?.pacingPaceDifference || 0))
        .slice(0, 3)
        .map(m => `${m.manager.name} (${m.metrics.execution?.pacingPaceDifference}%)`);

      const laggingText = laggingManagers.length > 0 ? laggingManagers.join(', ') : 'нет';
      const weekNum = this.getIsoWeekNumber(localDate);
      const digestYear = localDate.getUTCFullYear();

      const digestMessage = `План компании на ${effectivePeriod}: факт ${factPercent}% (${netDeals}/${targetDeals} сделок, $${netVolUsd}). Касса: $${cashUsd}. Прогноз: ${forecastPercent}%. Отстающие менеджеры: ${laggingText}.`;

      for (const userId of managementUserIds) {
        const dedupeKey = `SALES_PLAN_WEEKLY_DIGEST:${userId}:${effectivePeriod}:WEEK_${weekNum}_${digestYear}`;
        const notifPayload = {
          user_id: userId,
          event_type: 'SALES_PLAN_WEEKLY_DIGEST',
          type: 'SALES_PLAN_WEEKLY_DIGEST',
          title: `📊 Еженедельный дайджест плана продаж (Неделя #${weekNum})`,
          message: digestMessage,
          entity_type: 'DIGEST',
          entity_id: 0,
          action_url: `/leads?tab=sales-plan&period=${effectivePeriod}`,
          dedupe_key: dedupeKey,
          metadata: {
            period: effectivePeriod,
            week_number: weekNum,
            year: digestYear,
            net_deals: netDeals,
            target_deals: targetDeals,
            cash_collected_usd: dept.cashCollected?.volumeUsd || 0,
            fact_percent: factPercent,
            forecast_percent: forecastPercent,
            lagging_managers: laggingManagers
          }
        };

        stats.weeklyDigestNotified++;
        stats.notificationsCreated.push({ dedupeKey, userId, eventType: 'SALES_PLAN_WEEKLY_DIGEST' });

        if (!isDryRun) {
          await NotificationsRepository.createNotification(notifPayload);
        }
      }
    }

    return stats;
  }
}
