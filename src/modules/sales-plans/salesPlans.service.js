import { SalesPlansRepository } from './salesPlans.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class SalesPlansService {
  /**
   * Calculate working days pacing for Asia/Dushanbe timezone (Mon-Sat, 6 days/wk)
   */
  static calculateWorkingDaysPacing(period) {
    const [year, month] = period.split('-').map(Number);
    const totalDaysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    // Get current Dushanbe time
    const now = new Date();
    const dushanbeFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dushanbe',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const currentDushanbeDateStr = dushanbeFormatter.format(now); // 'YYYY-MM-DD'
    const [curYear, curMonth, curDay] = currentDushanbeDateStr.split('-').map(Number);
    const currentPeriodStr = `${curYear}-${String(curMonth).padStart(2, '0')}`;

    let totalWorkingDays = 0;
    let elapsedWorkingDays = 0;

    for (let day = 1; day <= totalDaysInMonth; day++) {
      const d = new Date(Date.UTC(year, month - 1, day));
      const dayOfWeek = d.getUTCDay(); // 0 = Sunday, 1..6 = Mon..Sat
      const isWorkingDay = dayOfWeek !== 0; // Monday to Saturday are working days

      if (isWorkingDay) {
        totalWorkingDays++;
        if (period < currentPeriodStr) {
          // Past month: all working days are elapsed
          elapsedWorkingDays++;
        } else if (period === currentPeriodStr) {
          // Current month: count working days up to today
          if (day <= curDay) {
            elapsedWorkingDays++;
          }
        }
        // Future month: elapsed remains 0
      }
    }

    const remainingWorkingDays = Math.max(0, totalWorkingDays - elapsedWorkingDays);
    const pacingRatio = totalWorkingDays > 0 ? Number((elapsedWorkingDays / totalWorkingDays).toFixed(4)) : 0;
    const pacingPercent = Number((pacingRatio * 100).toFixed(1));

    return {
      period,
      isCurrentPeriod: period === currentPeriodStr,
      isPastPeriod: period < currentPeriodStr,
      isFuturePeriod: period > currentPeriodStr,
      totalWorkingDays,
      elapsedWorkingDays,
      remainingWorkingDays,
      pacingPercent,
      hasSufficientDataForForecast: period < currentPeriodStr || elapsedWorkingDays >= 3
    };
  }

  /**
   * Fetch performance analytics (Plan vs Fact, Gross/Net, Forecast, Breakdowns)
   */
  static async getPerformanceData(query, user) {
    const role = user?.role || 'GUEST';
    if (role === 'FINANCE_MANAGER') {
      throw new AppError('Доступ к планам продаж запрещен для вашей роли', 403);
    }

    // Default period to current month in Asia/Dushanbe
    let period = query.period;
    if (!period) {
      const now = new Date();
      const dStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dushanbe',
        year: 'numeric',
        month: '2-digit'
      }).format(now);
      period = dStr.substring(0, 7);
    }

    // RBAC: If SALES_MANAGER, managerId parameter cannot be faked
    let requestedManagerId = query.managerId ? Number(query.managerId) : null;
    if (role === 'SALES_MANAGER') {
      requestedManagerId = Number(user.id);
    }

    const projectId = query.projectId ? Number(query.projectId) : null;
    const buildingId = query.buildingId ? Number(query.buildingId) : null;

    // 1. Working days pacing
    const pacing = this.calculateWorkingDaysPacing(period);

    // 2. Load Plans for period
    const rawPlans = await SalesPlansRepository.getPlansByPeriod(period);

    // 3. Load Deals with full hierarchy
    const allDeals = await SalesPlansRepository.getAllDealsWithHierarchy();

    // 4. Load Active Payments for period
    const activePayments = await SalesPlansRepository.getActivePaymentsForPeriod(period);

    // 5. Load Active Managers & Projects/Buildings
    const activeManagers = await SalesPlansRepository.getSalesManagers();
    const { projects, buildings } = await SalesPlansRepository.getProjectsAndBuildings();

    // 6. Partition Deals for Period
    const monthPrefix = `${period}-`;
    const diagnostics = {
      missingSigningDateCount: 0,
      missingCancellationDateCount: 0,
      unassignedDealsCount: 0
    };

    const periodGrossDeals = [];
    const periodCancelledDeals = [];

    for (const deal of allDeals) {
      // Must have contract number to count as sales contract
      const hasContract = Boolean(deal.contract_number && String(deal.contract_number).trim().length > 0);
      if (!hasContract) continue;

      // Signing date
      const rawSigningDate = deal.signed_at || deal.deal_date;
      const signingMonthStr = rawSigningDate ? String(rawSigningDate).substring(0, 7) : null;

      if (!signingMonthStr && deal.status === 'SIGNED') {
        diagnostics.missingSigningDateCount++;
      }

      // Check Gross: was it signed in this period?
      if (signingMonthStr === period) {
        periodGrossDeals.push(deal);
      }

      // Check Cancellations: was it cancelled in this period?
      if (deal.status === 'CANCELLED' || Boolean(deal.cancelled_at)) {
        const rawCancelDate = deal.cancelled_at;
        const cancelMonthStr = rawCancelDate ? String(rawCancelDate).substring(0, 7) : null;
        if (!cancelMonthStr) {
          diagnostics.missingCancellationDateCount++;
        } else if (cancelMonthStr === period) {
          periodCancelledDeals.push(deal);
        }
      }

      if (!deal.responsible_user_id) {
        diagnostics.unassignedDealsCount++;
      }
    }

    // Helper to evaluate metrics for a filtered set of deals
    const evaluateMetrics = (grossList, cancelList, targetPlan = null) => {
      const grossCount = grossList.length;
      const grossVolumeMinor = grossList.reduce((sum, d) => sum + BigInt(d.final_price_minor || 0), 0n);

      const cancelCount = cancelList.length;
      const cancelVolumeMinor = cancelList.reduce((sum, d) => sum + BigInt(d.final_price_minor || 0), 0n);

      // In-month vs Cross-month cancellations
      const inMonthCancellations = cancelList.filter(d => {
        const sMonth = (d.signed_at || d.deal_date || '').substring(0, 7);
        return sMonth === period;
      });
      const crossMonthCancellations = cancelList.filter(d => {
        const sMonth = (d.signed_at || d.deal_date || '').substring(0, 7);
        return sMonth !== period;
      });

      // Net = Gross - Total Cancellations in period
      const netCount = grossCount - cancelCount;
      const netVolumeMinor = grossVolumeMinor - cancelVolumeMinor;

      // Unique buyers
      const uniqueBuyers = new Set(grossList.map(d => d.lead_id).filter(Boolean));

      // Target plans
      const targetDeals = targetPlan ? Number(targetPlan.target_deals_count || 0) : 0;
      const targetVolume = targetPlan ? BigInt(targetPlan.target_volume_minor || 0) : 0n;

      // Execution percentage
      const dealsExecutionPercent = targetDeals > 0 ? Number(((netCount / targetDeals) * 100).toFixed(1)) : (netCount > 0 ? 100 : 0);
      const volumeExecutionPercent = targetVolume > 0n
        ? Number(((Number(netVolumeMinor) / Number(targetVolume)) * 100).toFixed(1))
        : (netVolumeMinor > 0n ? 100 : 0);

      // Forecast calculation (Pacing velocity)
      let forecastDeals = null;
      let forecastVolumeMinor = null;
      let forecastDeviationDeals = null;
      let forecastDeviationVolumeMinor = null;
      let forecastStatus = 'NO_DATA'; // 'INSUFFICIENT_DATA', 'ON_TRACK', 'BEHIND', 'EXCEEDED'

      if (!pacing.hasSufficientDataForForecast) {
        forecastStatus = 'INSUFFICIENT_DATA';
      } else if (pacing.isPastPeriod) {
        // Closed month: forecast is the actual fact
        forecastDeals = netCount;
        forecastVolumeMinor = Number(netVolumeMinor);
        forecastDeviationDeals = netCount - targetDeals;
        forecastDeviationVolumeMinor = Number(netVolumeMinor - targetVolume);
        forecastStatus = netCount >= targetDeals ? 'EXCEEDED' : 'BEHIND';
      } else {
        // Current month with >= 3 elapsed working days
        const dailyRateDeals = pacing.elapsedWorkingDays > 0 ? netCount / pacing.elapsedWorkingDays : 0;
        const dailyRateVolume = pacing.elapsedWorkingDays > 0 ? Number(netVolumeMinor) / pacing.elapsedWorkingDays : 0;

        forecastDeals = Math.round(netCount + (dailyRateDeals * pacing.remainingWorkingDays));
        forecastVolumeMinor = Math.round(Number(netVolumeMinor) + (dailyRateVolume * pacing.remainingWorkingDays));

        forecastDeviationDeals = forecastDeals - targetDeals;
        forecastDeviationVolumeMinor = forecastVolumeMinor - Number(targetVolume);

        if (dealsExecutionPercent >= pacing.pacingPercent) {
          forecastStatus = forecastDeals >= targetDeals ? 'EXCEEDED' : 'ON_TRACK';
        } else {
          forecastStatus = 'BEHIND';
        }
      }

      return {
        gross: {
          count: grossCount,
          volumeMinor: Number(grossVolumeMinor),
          volumeUsd: Number((Number(grossVolumeMinor) / 100).toFixed(2))
        },
        cancellations: {
          totalCount: cancelCount,
          totalVolumeMinor: Number(cancelVolumeMinor),
          totalVolumeUsd: Number((Number(cancelVolumeMinor) / 100).toFixed(2)),
          inMonthCount: inMonthCancellations.length,
          crossMonthCount: crossMonthCancellations.length
        },
        net: {
          count: netCount,
          volumeMinor: Number(netVolumeMinor),
          volumeUsd: Number((Number(netVolumeMinor) / 100).toFixed(2))
        },
        uniqueBuyersCount: uniqueBuyers.size,
        target: {
          dealsCount: targetDeals,
          volumeMinor: Number(targetVolume),
          volumeUsd: Number((Number(targetVolume) / 100).toFixed(2)),
          status: targetPlan?.status || 'NOT_SET'
        },
        execution: {
          dealsPercent: dealsExecutionPercent,
          volumePercent: volumeExecutionPercent,
          pacingPaceDifference: Number((dealsExecutionPercent - pacing.pacingPercent).toFixed(1))
        },
        forecast: {
          status: forecastStatus,
          deals: forecastDeals,
          volumeMinor: forecastVolumeMinor,
          volumeUsd: forecastVolumeMinor !== null ? Number((forecastVolumeMinor / 100).toFixed(2)) : null,
          deviationDeals: forecastDeviationDeals,
          deviationVolumeMinor: forecastDeviationVolumeMinor,
          deviationVolumeUsd: forecastDeviationVolumeMinor !== null ? Number((forecastDeviationVolumeMinor / 100).toFixed(2)) : null
        }
      };
    };

    // --- DEPARTMENT / COMPANY LEVEL METRICS ---
    const deptPlan = rawPlans.find(p => p.scope_type === 'DEPARTMENT');
    const departmentMetrics = evaluateMetrics(periodGrossDeals, periodCancelledDeals, deptPlan);

    // Calculate actual cash collected during this month for deals
    const cashCollectedMinor = activePayments.reduce((sum, p) => sum + (p.amount_minor || 0), 0);
    const cashCollectedUsd = activePayments.reduce((sum, p) => sum + Number(p.amount_usd || (p.amount_minor / 100) || 0), 0);

    departmentMetrics.cashCollected = {
      volumeMinor: cashCollectedMinor,
      volumeUsd: Number(cashCollectedUsd.toFixed(2)),
      cashToContractRatio: departmentMetrics.gross.volumeUsd > 0
        ? Number(((cashCollectedUsd / departmentMetrics.gross.volumeUsd) * 100).toFixed(1))
        : 0
    };

    // --- MANAGER BREAKDOWN ---
    const managerBreakdown = [];
    for (const mgr of activeManagers) {
      const isSelf = mgr.id === requestedManagerId;
      const isRestricted = role === 'SALES_MANAGER' && !isSelf;

      // Skip colleagues if user is SALES_MANAGER
      if (role === 'SALES_MANAGER' && !isSelf) {
        continue;
      }

      const mgrPlan = rawPlans.find(p => p.scope_type === 'MANAGER' && Number(p.manager_id) === Number(mgr.id));
      const mgrGrossDeals = periodGrossDeals.filter(d => Number(d.responsible_user_id) === Number(mgr.id));
      const mgrCancelledDeals = periodCancelledDeals.filter(d => Number(d.responsible_user_id) === Number(mgr.id));

      const metrics = evaluateMetrics(mgrGrossDeals, mgrCancelledDeals, mgrPlan);

      managerBreakdown.push({
        manager: {
          id: mgr.id,
          name: mgr.name,
          role: mgr.role,
          email: mgr.email
        },
        metrics
      });
    }

    // --- PROJECT & BUILDING (BLOCK) BREAKDOWN ---
    const buildingBreakdown = [];
    for (const bld of buildings) {
      const bldPlan = rawPlans.find(p => p.scope_type === 'BUILDING' && Number(p.building_id) === Number(bld.id));
      const bldGrossDeals = periodGrossDeals.filter(d => d.units?.floors?.sections?.buildings?.id === bld.id);
      const bldCancelledDeals = periodCancelledDeals.filter(d => d.units?.floors?.sections?.buildings?.id === bld.id);

      const metrics = evaluateMetrics(bldGrossDeals, bldCancelledDeals, bldPlan);

      buildingBreakdown.push({
        building: {
          id: bld.id,
          name: bld.name,
          code: bld.code,
          projectId: bld.project_id
        },
        metrics
      });
    }

    return {
      period,
      pacing,
      currency: 'USD',
      userRole: role,
      isRestrictedToSelf: role === 'SALES_MANAGER',
      department: departmentMetrics,
      managers: managerBreakdown,
      buildings: buildingBreakdown,
      diagnostics
    };
  }

  /**
   * Batch save or update sales plans (ADMIN only)
   */
  static async batchSavePlans(payload, user) {
    if (user?.role !== 'ADMIN') {
      throw new AppError('Только Администратор имеет право создавать и изменять планы продаж', 403);
    }

    const { period, plans, reason } = payload;
    const currentPeriodStr = new Date().toISOString().substring(0, 7);

    // If period is current or past month, reason is mandatory
    if (period <= currentPeriodStr && (!reason || reason.trim().length < 10)) {
      throw new AppError('Для изменения плана текущего или закрытого периода требуется обоснование (минимум 10 символов)', 400);
    }

    const savedPlans = [];

    for (const planItem of plans) {
      // Find existing plan for identical scope
      const existing = await SalesPlansRepository.findExistingPlan(period, planItem.scope_type, {
        managerId: planItem.manager_id,
        projectId: planItem.project_id,
        buildingId: planItem.building_id
      });

      const planRecord = {
        id: existing ? existing.id : planItem.id,
        period,
        scope_type: planItem.scope_type,
        manager_id: planItem.manager_id || null,
        project_id: planItem.project_id || null,
        building_id: planItem.building_id || null,
        target_deals_count: planItem.target_deals_count,
        target_volume_minor: planItem.target_volume_minor,
        currency: 'USD',
        status: existing?.status === 'APPROVED' ? 'APPROVED' : (planItem.status || 'DRAFT'),
        created_by: existing ? existing.created_by : user.id
      };

      const result = await SalesPlansRepository.savePlan(planRecord);
      savedPlans.push(result);

      // Audit log
      await SalesPlansRepository.createAuditLog({
        sales_plan_id: result.id,
        action: existing ? 'UPDATE' : 'CREATE',
        old_values: existing ? {
          target_deals_count: existing.target_deals_count,
          target_volume_minor: existing.target_volume_minor,
          status: existing.status
        } : null,
        new_values: {
          target_deals_count: result.target_deals_count,
          target_volume_minor: result.target_volume_minor,
          status: result.status
        },
        reason: reason || (existing ? 'Корректировка плана продаж' : 'Первоначальное создание плана продаж'),
        changed_by_user_id: user.id
      });
    }

    return savedPlans;
  }

  /**
   * Approve a plan (ADMIN only)
   */
  static async approvePlan(id, reason, user) {
    if (user?.role !== 'ADMIN') {
      throw new AppError('Только Администратор имеет право утверждать планы продаж', 403);
    }

    const existing = await SalesPlansRepository.getPlanById(id);
    if (!existing) {
      throw new AppError('План продаж не найден', 404);
    }

    const approved = await SalesPlansRepository.approvePlan(id, user.id);

    await SalesPlansRepository.createAuditLog({
      sales_plan_id: id,
      action: 'APPROVE',
      old_values: { status: existing.status },
      new_values: { status: 'APPROVED', approved_by: user.id },
      reason: reason || 'Утверждение плана продаж руководителем',
      changed_by_user_id: user.id
    });

    return approved;
  }

  /**
   * Get audit logs for plans (ADMIN only)
   */
  static async getAuditLogs(filters, user) {
    if (user?.role !== 'ADMIN') {
      throw new AppError('История корректировок планов доступна только Администратору', 403);
    }
    return SalesPlansRepository.getAuditLogs(filters);
  }

  /**
   * Get drill-down deals breakdown
   */
  static async getDealsBreakdown(query, user) {
    const role = user?.role || 'GUEST';
    if (role === 'FINANCE_MANAGER') {
      throw new AppError('Доступ к сделкам планов продаж запрещен', 403);
    }

    const { period, type = 'GROSS' } = query;
    let managerId = query.managerId ? Number(query.managerId) : null;
    if (role === 'SALES_MANAGER') {
      managerId = Number(user.id);
    }

    const buildingId = query.buildingId ? Number(query.buildingId) : null;
    const allDeals = await SalesPlansRepository.getAllDealsWithHierarchy();

    const filtered = allDeals.filter(d => {
      // Must have contract number
      if (!d.contract_number) return false;

      // Manager filter
      if (managerId && Number(d.responsible_user_id) !== managerId) {
        return false;
      }

      // Building filter
      if (buildingId && d.units?.floors?.sections?.buildings?.id !== buildingId) {
        return false;
      }

      const sMonth = (d.signed_at || d.deal_date || '').substring(0, 7);
      const cMonth = (d.cancelled_at || '').substring(0, 7);

      if (type === 'GROSS') {
        return sMonth === period;
      } else if (type === 'CANCELLATIONS') {
        return (d.status === 'CANCELLED' || Boolean(d.cancelled_at)) && cMonth === period;
      } else {
        // NET: gross signed in period OR cancelled in period
        return sMonth === period || cMonth === period;
      }
    });

    return filtered.map(d => ({
      id: d.id,
      contractNumber: d.contract_number,
      clientName: d.leads?.full_name || 'Клиент',
      managerName: d.users?.name || 'Не назначен',
      buildingName: d.units?.floors?.sections?.buildings?.name || 'Блок не указан',
      unitNumber: d.units?.unit_number || '',
      rooms: d.units?.rooms,
      areaM2: d.units?.area_m2_x100 ? d.units.area_m2_x100 / 100 : null,
      status: d.status,
      finalPriceUsd: d.final_price_minor ? (d.final_price_minor / 100) : 0,
      dealDate: d.deal_date,
      signedAt: d.signed_at,
      cancelledAt: d.cancelled_at,
      cancellationReason: d.cancellation_reason
    }));
  }
}
