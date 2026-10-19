import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { getBusinessDate } from '../../utils/businessTime.js';

const getSecureDB = () => {
  try {
    if (typeof getServiceDB === 'function') {
      const sdb = getServiceDB();
      if (sdb) return sdb;
    }
  } catch {}
  return getDB();
};

export class BlockPlanFactService {
  /**
   * Helper to verify role and enforce RBAC
   */
  static checkAccess(user) {
    if (!user) {
      throw new AppError('Пользователь не авторизован', 401);
    }
    if (['FINANCE_MANAGER', 'WAREHOUSE_MANAGER'].includes(user.role)) {
      throw new AppError('Доступ к план-факту по блокам запрещен для вашей роли', 403);
    }
  }

  /**
   * Generates Plan-Fact Report broken down by Blocks (Buildings) and Managers
   * @param {Object} query - { period, projectId, managerId }
   * @param {Object} user - Authenticated user object
   */
  static async getBlockPlanFact(query = {}, user) {
    this.checkAccess(user);

    const db = getSecureDB();
    const isSupervisor = ['ADMIN', 'DIRECTOR'].includes(user.role);
    const userId = Number(user.id);

    // Default period: current month (YYYY-MM) in Asia/Dushanbe
    const todayStr = getBusinessDate();
    const period = query.period ? String(query.period).trim() : todayStr.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new AppError('Неверный формат периода. Ожидается формат YYYY-MM', 400);
    }

    const projectIdFilter = query.projectId && query.projectId !== 'ALL' ? Number(query.projectId) : null;
    let managerIdFilter = query.managerId && query.managerId !== 'ALL' ? Number(query.managerId) : null;

    if (!isSupervisor) {
      managerIdFilter = userId;
    }

    // 1. Fetch Buildings (Blocks)
    let buildingsQuery = db
      .from('buildings')
      .select('id, name, code, project_id, projects!project_id ( id, name, currency )')
      .order('id', { ascending: true });

    if (projectIdFilter) {
      buildingsQuery = buildingsQuery.eq('project_id', projectIdFilter);
    }

    const { data: rawBuildings, error: bErr } = await buildingsQuery;
    if (bErr) {
      console.error('[BlockPlanFactService] Error fetching buildings:', bErr.message);
      throw new AppError('Ошибка при получении списка блоков', 500);
    }
    const buildings = rawBuildings || [];

    // 2. Fetch Sales Plans for the specified period
    let plansQuery = db
      .from('sales_plans')
      .select('*')
      .eq('period', period);

    const { data: rawPlans, error: pErr } = await plansQuery;
    if (pErr) {
      console.warn('[BlockPlanFactService] Notice: sales_plans query restricted or empty:', pErr.message);
    }
    const plans = rawPlans || [];

    // Department / Project overall plan
    const deptPlan = plans.find(p => p.scope_type === 'DEPARTMENT');
    const projPlan = projectIdFilter ? plans.find(p => p.scope_type === 'PROJECT' && Number(p.project_id) === projectIdFilter) : null;

    // 3. Fetch Deals for the period with building hierarchy
    let dealsQuery = db
      .from('deals')
      .select(`
        id, contract_number, lead_id, unit_id, responsible_user_id,
        status, payment_type, currency, final_price_minor,
        reservation_expires_at, deal_date, signed_at, cancelled_at, created_at,
        leads ( id, full_name, phone ),
        units (
          id, unit_number, unit_kind, rooms, area_m2_x100, price_per_m2_minor,
          floors (
            id, floor_number,
            sections (
              id, name,
              buildings ( id, name, project_id, projects ( id, name ) )
            )
          )
        ),
        users!responsible_user_id ( id, name )
      `);

    if (!isSupervisor) {
      dealsQuery = dealsQuery.eq('responsible_user_id', userId);
    } else if (managerIdFilter) {
      dealsQuery = dealsQuery.eq('responsible_user_id', managerIdFilter);
    }

    const { data: rawDeals, error: dErr } = await dealsQuery;
    if (dErr) {
      console.error('[BlockPlanFactService] Error fetching deals:', dErr.message);
      throw new AppError('Ошибка при получении сделок для план-факта', 500);
    }
    let allDeals = rawDeals || [];

    if (projectIdFilter) {
      allDeals = allDeals.filter(d => Number(d.units?.floors?.sections?.buildings?.project_id) === projectIdFilter);
    }

    // 4. Group by Building (Block)
    const blocksData = buildings.map(building => {
      const bId = Number(building.id);

      // Building deals
      const buildingDeals = allDeals.filter(d => Number(d.units?.floors?.sections?.buildings?.id) === bId);

      // A. Signed Deals in period (Rule: status = SIGNED / CONTRACTED / COMPLETED, cancelled excluded!)
      const signedDeals = buildingDeals.filter(d => {
        if (!['SIGNED', 'CONTRACTED', 'COMPLETED'].includes(d.status) || d.status === 'CANCELLED') return false;
        const signingDate = d.signed_at ? getBusinessDate(d.signed_at) : (d.deal_date ? d.deal_date.slice(0, 10) : null);
        return signingDate && signingDate.startsWith(period);
      }).map(d => {
        const areaM2 = (d.units?.area_m2_x100 || 0) / 100;
        const volumeMinor = d.final_price_minor || 0;
        return {
          id: d.id,
          contractNumber: d.contract_number ? `№${d.contract_number}` : `Договор #${d.id}`,
          leadId: d.lead_id,
          clientName: d.leads?.full_name || 'Клиент',
          phone: d.leads?.phone || '',
          unitNumber: d.units?.unit_number || '—',
          rooms: d.units?.rooms,
          areaM2,
          finalPriceMinor: volumeMinor,
          finalPriceUsd: Number((volumeMinor / 100).toFixed(2)),
          currency: d.currency || 'USD',
          signedAt: d.signed_at || d.deal_date,
          managerId: d.responsible_user_id,
          managerName: d.users?.name || 'Менеджер'
        };
      });

      // B. Active Reservations in period (Rule: Pipeline, separate from sales!)
      const reservedDeals = buildingDeals.filter(d => {
        if (d.status !== 'RESERVED') return false;
        const resDate = d.created_at ? getBusinessDate(d.created_at) : (d.deal_date ? d.deal_date.slice(0, 10) : null);
        return resDate && resDate.startsWith(period);
      }).map(d => {
        const areaM2 = (d.units?.area_m2_x100 || 0) / 100;
        const volumeMinor = d.final_price_minor || 0;
        return {
          id: d.id,
          contractNumber: d.contract_number ? `№${d.contract_number}` : `Бронь #${d.id}`,
          leadId: d.lead_id,
          clientName: d.leads?.full_name || 'Клиент',
          phone: d.leads?.phone || '',
          unitNumber: d.units?.unit_number || '—',
          rooms: d.units?.rooms,
          areaM2,
          finalPriceMinor: volumeMinor,
          finalPriceUsd: Number((volumeMinor / 100).toFixed(2)),
          currency: d.currency || 'USD',
          reservationExpiresAt: d.reservation_expires_at,
          dealDate: d.deal_date || d.created_at,
          managerId: d.responsible_user_id,
          managerName: d.users?.name || 'Менеджер'
        };
      });

      // C. Cancelled Deals in period (Rule: Strictly separate from active sales!)
      const cancelledDeals = buildingDeals.filter(d => {
        if (d.status !== 'CANCELLED') return false;
        const cDate = d.cancelled_at ? getBusinessDate(d.cancelled_at) : (d.updated_at ? getBusinessDate(d.updated_at) : (d.deal_date ? d.deal_date.slice(0, 10) : null));
        return cDate && cDate.startsWith(period);
      }).map(d => {
        const areaM2 = (d.units?.area_m2_x100 || 0) / 100;
        const volumeMinor = d.final_price_minor || 0;
        return {
          id: d.id,
          contractNumber: d.contract_number ? `№${d.contract_number}` : `Сделка #${d.id}`,
          leadId: d.lead_id,
          clientName: d.leads?.full_name || 'Клиент',
          phone: d.leads?.phone || '',
          unitNumber: d.units?.unit_number || '—',
          areaM2,
          finalPriceMinor: volumeMinor,
          finalPriceUsd: Number((volumeMinor / 100).toFixed(2)),
          currency: d.currency || 'USD',
          cancellationReason: d.cancellation_reason || 'Не указана',
          cancelledAt: d.cancelled_at || d.deal_date,
          managerId: d.responsible_user_id
        };
      });

      // Plans for this building
      const bPlan = plans.find(p => p.scope_type === 'BUILDING' && Number(p.building_id) === bId);
      const targetDealsCount = bPlan?.target_deals_count || 0;
      const targetVolumeMinor = bPlan?.target_volume_minor || 0;
      const targetVolumeUsd = Number((targetVolumeMinor / 100).toFixed(2));

      // Fact calculations
      const signedDealsCount = signedDeals.length;
      const signedAreaM2 = signedDeals.reduce((sum, d) => sum + d.areaM2, 0);
      const signedVolumeMinor = signedDeals.reduce((sum, d) => sum + d.finalPriceMinor, 0);
      const signedVolumeUsd = Number((signedVolumeMinor / 100).toFixed(2));
      const averagePricePerM2Usd = signedAreaM2 > 0 ? Math.round(signedVolumeUsd / signedAreaM2) : 0;

      // Plan Execution
      const dealsExecutionPercent = targetDealsCount > 0
        ? Number(((signedDealsCount / targetDealsCount) * 100).toFixed(1))
        : 0;
      const volumeExecutionPercent = targetVolumeMinor > 0
        ? Number(((signedVolumeMinor / targetVolumeMinor) * 100).toFixed(1))
        : 0;
      const dealsGap = targetDealsCount - signedDealsCount;
      const volumeGapUsd = Number(((targetVolumeMinor - signedVolumeMinor) / 100).toFixed(2));

      // Pipeline (Reservations)
      const reservedDealsCount = reservedDeals.length;
      const reservedAreaM2 = reservedDeals.reduce((sum, d) => sum + d.areaM2, 0);
      const reservedVolumeMinor = reservedDeals.reduce((sum, d) => sum + d.finalPriceMinor, 0);
      const reservedVolumeUsd = Number((reservedVolumeMinor / 100).toFixed(2));

      // Cancelled
      const cancelledDealsCount = cancelledDeals.length;
      const cancelledVolumeMinor = cancelledDeals.reduce((sum, d) => sum + d.finalPriceMinor, 0);
      const cancelledVolumeUsd = Number((cancelledVolumeMinor / 100).toFixed(2));

      // Manager Breakdown within this Block
      const managerMap = {};
      signedDeals.forEach(d => {
        const mid = d.managerId || 0;
        if (!managerMap[mid]) {
          managerMap[mid] = {
            managerId: d.managerId,
            managerName: d.managerName,
            signedDealsCount: 0,
            signedVolumeMinor: 0,
            signedAreaM2: 0,
            reservedDealsCount: 0,
            reservedVolumeMinor: 0
          };
        }
        managerMap[mid].signedDealsCount++;
        managerMap[mid].signedVolumeMinor += d.finalPriceMinor;
        managerMap[mid].signedAreaM2 += d.areaM2;
      });

      reservedDeals.forEach(d => {
        const mid = d.managerId || 0;
        if (!managerMap[mid]) {
          managerMap[mid] = {
            managerId: d.managerId,
            managerName: d.managerName,
            signedDealsCount: 0,
            signedVolumeMinor: 0,
            signedAreaM2: 0,
            reservedDealsCount: 0,
            reservedVolumeMinor: 0
          };
        }
        managerMap[mid].reservedDealsCount++;
        managerMap[mid].reservedVolumeMinor += d.finalPriceMinor;
      });

      const managersBreakdown = Object.values(managerMap).map(m => ({
        ...m,
        signedVolumeUsd: Number((m.signedVolumeMinor / 100).toFixed(2)),
      })).sort((a, b) => b.signedVolumeMinor - a.signedVolumeMinor);

      const rawLimit = query.drilldownLimit || query.blockDrilldownLimit;
      const blockDrilldownLimit = rawLimit ? Math.max(1, Math.min(100, parseInt(rawLimit, 10))) : 50;

      return {
        buildingId: building.id,
        buildingName: building.name,
        buildingCode: building.code,
        projectId: building.project_id,
        projectName: building.projects?.name || 'Объект',
        plan: {
          targetDealsCount,
          targetVolumeMinor,
          targetVolumeUsd
        },
        fact: {
          signedDealsCount,
          signedAreaM2: Number(signedAreaM2.toFixed(2)),
          signedVolumeMinor,
          signedVolumeUsd,
          averagePricePerM2Usd
        },
        execution: {
          dealsPercent: dealsExecutionPercent,
          volumePercent: volumeExecutionPercent,
          dealsGap,
          volumeGapUsd
        },
        pipelineReserved: {
          reservedDealsCount,
          reservedAreaM2: Number(reservedAreaM2.toFixed(2)),
          reservedVolumeMinor,
          reservedVolumeUsd
        },
        cancelled: {
          cancelledDealsCount,
          cancelledVolumeMinor,
          cancelledVolumeUsd
        },
        managersBreakdown,
        drilldowns: {
          signedDeals: signedDeals.slice(0, blockDrilldownLimit),
          reservedDeals: reservedDeals.slice(0, blockDrilldownLimit),
          cancelledDeals: cancelledDeals.slice(0, blockDrilldownLimit)
        },
        drilldownMeta: {
          limit: blockDrilldownLimit,
          totals: {
            signedDeals: signedDeals.length,
            reservedDeals: reservedDeals.length,
            cancelledDeals: cancelledDeals.length
          },
          isTruncated: {
            signedDeals: signedDeals.length > blockDrilldownLimit,
            reservedDeals: reservedDeals.length > blockDrilldownLimit,
            cancelledDeals: cancelledDeals.length > blockDrilldownLimit
          }
        }
      };
    });

    // Department / Overall summary
    const totalTargetDeals = blocksData.reduce((sum, b) => sum + b.plan.targetDealsCount, 0) || (deptPlan?.target_deals_count || projPlan?.target_deals_count || 0);
    const totalTargetVolumeMinor = blocksData.reduce((sum, b) => sum + b.plan.targetVolumeMinor, 0) || (deptPlan?.target_volume_minor || projPlan?.target_volume_minor || 0);

    const totalSignedDeals = blocksData.reduce((sum, b) => sum + b.fact.signedDealsCount, 0);
    const totalSignedAreaM2 = blocksData.reduce((sum, b) => sum + b.fact.signedAreaM2, 0);
    const totalSignedVolumeMinor = blocksData.reduce((sum, b) => sum + b.fact.signedVolumeMinor, 0);

    const totalReservedDeals = blocksData.reduce((sum, b) => sum + b.pipelineReserved.reservedDealsCount, 0);
    const totalReservedVolumeMinor = blocksData.reduce((sum, b) => sum + b.pipelineReserved.reservedVolumeMinor, 0);
    const totalReservedAreaM2 = blocksData.reduce((sum, b) => sum + b.pipelineReserved.reservedAreaM2, 0);

    const totalCancelledDeals = blocksData.reduce((sum, b) => sum + b.cancelled.cancelledDealsCount, 0);
    const totalCancelledVolumeMinor = blocksData.reduce((sum, b) => sum + b.cancelled.cancelledVolumeMinor, 0);

    const overallDealsExecutionPercent = totalTargetDeals > 0
      ? Number(((totalSignedDeals / totalTargetDeals) * 100).toFixed(1))
      : 0;
    const overallVolumeExecutionPercent = totalTargetVolumeMinor > 0
      ? Number(((totalSignedVolumeMinor / totalTargetVolumeMinor) * 100).toFixed(1))
      : 0;

    return {
      period,
      timezone: 'Asia/Dushanbe',
      isSupervisor,
      summary: {
        totalBlocksCount: blocksData.length,
        plan: {
          targetDealsCount: totalTargetDeals,
          targetVolumeMinor: totalTargetVolumeMinor,
          targetVolumeUsd: Number((totalTargetVolumeMinor / 100).toFixed(2))
        },
        fact: {
          signedDealsCount: totalSignedDeals,
          signedAreaM2: Number(totalSignedAreaM2.toFixed(2)),
          signedVolumeMinor: totalSignedVolumeMinor,
          signedVolumeUsd: Number((totalSignedVolumeMinor / 100).toFixed(2))
        },
        execution: {
          dealsPercent: overallDealsExecutionPercent,
          volumePercent: overallVolumeExecutionPercent,
          dealsGap: totalTargetDeals - totalSignedDeals,
          volumeGapUsd: Number(((totalTargetVolumeMinor - totalSignedVolumeMinor) / 100).toFixed(2))
        },
        pipelineReserved: {
          reservedDealsCount: totalReservedDeals,
          reservedAreaM2: Number(totalReservedAreaM2.toFixed(2)),
          reservedVolumeMinor: totalReservedVolumeMinor,
          reservedVolumeUsd: Number((totalReservedVolumeMinor / 100).toFixed(2))
        },
        cancelled: {
          cancelledDealsCount: totalCancelledDeals,
          cancelledVolumeMinor: totalCancelledVolumeMinor,
          cancelledVolumeUsd: Number((totalCancelledVolumeMinor / 100).toFixed(2))
        }
      },
      blocks: blocksData
    };
  }
}
