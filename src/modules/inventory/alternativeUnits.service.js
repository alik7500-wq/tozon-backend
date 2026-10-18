import { getDB } from '../../db/connection.js';
import { InventoryRepository } from './inventory.repository.js';
import { LeadsRepository } from '../leads/leads.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class AlternativeUnitsService {
  /**
   * Finds available alternative apartments for a reference unit.
   * Matching criteria:
   * - Status: AVAILABLE
   * - Unit kind: matches reference (defaults to APARTMENT)
   * - Rooms: exact match (or +/- 1 room if allowed)
   * - Area: within +/- 20%
   * - Budget: within +/- 20% (if price is set)
   * - Strictly advisory: does NOT alter existing units or deals.
   */
  static async getAlternativesForUnit(unitId, options = {}) {
    const cleanUnitId = Number(unitId);
    if (!cleanUnitId || isNaN(cleanUnitId)) {
      throw new AppError('Некорректный идентификатор квартиры', 400);
    }

    const refUnit = await InventoryRepository.getUnitById(cleanUnitId);
    if (!refUnit) {
      throw new AppError('Исходная квартира не найдена', 404);
    }

    const refAreaM2 = refUnit.area_m2_x100 ? refUnit.area_m2_x100 / 100 : 0;
    const refPricePerM2 = refUnit.price_per_m2_minor ? Math.round(refUnit.price_per_m2_minor / 100) : 0;
    const refTotalPrice = refUnit.manual_total_price_minor
      ? Math.round(refUnit.manual_total_price_minor / 100)
      : Math.round(refAreaM2 * refPricePerM2);
    const refRooms = Number(refUnit.rooms || 1);
    const refProjectId = refUnit.floors?.sections?.buildings?.projects?.id || null;
    const refBuildingId = refUnit.floors?.sections?.buildings?.id || null;

    const areaTolerance = options.areaTolerancePercent ? options.areaTolerancePercent / 100 : 0.20; // 20%
    const priceTolerance = options.priceTolerancePercent ? options.priceTolerancePercent / 100 : 0.20; // 20%
    const maxResults = options.limit || 5;

    const minArea = refAreaM2 * (1 - areaTolerance);
    const maxArea = refAreaM2 * (1 + areaTolerance);

    const minPrice = refTotalPrice > 0 ? refTotalPrice * (1 - priceTolerance) : 0;
    const maxPrice = refTotalPrice > 0 ? refTotalPrice * (1 + priceTolerance) : Infinity;

    const db = getDB();

    // Query all AVAILABLE units
    const { data: rawUnits, error } = await db
      .from('units')
      .select(`
        id,
        unit_number,
        unit_kind,
        rooms,
        area_m2_x100,
        price_per_m2_minor,
        manual_total_price_minor,
        status,
        floor_id,
        layout_type_id,
        floors (
          id,
          floor_number,
          sections (
            id,
            name,
            buildings (
              id,
              name,
              projects (
                id,
                name
              )
            )
          )
        ),
        layout_types (
          id,
          name,
          image_path
        )
      `)
      .eq('status', 'AVAILABLE')
      .neq('id', cleanUnitId);

    if (error || !rawUnits) {
      console.warn('[AlternativeUnitsService] Failed to query available units:', error?.message);
      return [];
    }

    // Filter and score candidates
    const scoredCandidates = [];

    for (const unit of rawUnits) {
      // Exclude non-residential if refUnit is apartment
      if (refUnit.unit_kind && unit.unit_kind && unit.unit_kind !== refUnit.unit_kind) {
        continue;
      }

      const rooms = Number(unit.rooms || 1);
      const roomDiff = Math.abs(rooms - refRooms);
      // Allow exact match or +/- 1 room max
      if (roomDiff > 1) continue;

      const areaM2 = unit.area_m2_x100 ? unit.area_m2_x100 / 100 : 0;
      // Area must be within tolerance (if refArea > 0)
      if (refAreaM2 > 0 && (areaM2 < minArea || areaM2 > maxArea)) {
        continue;
      }

      const pricePerM2 = unit.price_per_m2_minor ? Math.round(unit.price_per_m2_minor / 100) : 0;
      const totalPrice = unit.manual_total_price_minor
        ? Math.round(unit.manual_total_price_minor / 100)
        : Math.round(areaM2 * pricePerM2);

      // Budget check (if refTotalPrice > 0 and unit has price)
      if (refTotalPrice > 0 && totalPrice > 0) {
        if (totalPrice < minPrice || totalPrice > maxPrice) {
          continue;
        }
      }

      // Compute matching score & match reasons
      let score = 50;
      const matchReasons = [];

      // 1. Room matching
      if (roomDiff === 0) {
        score += 40;
        matchReasons.push(`Комнатность: совпадает (${rooms} комн.)`);
      } else {
        score += 10;
        matchReasons.push(`Комнатность: ${rooms} комн. (${rooms > refRooms ? '+1 комн.' : '-1 комн.'})`);
      }

      // 2. Location matching (building / project)
      const uProjectId = unit.floors?.sections?.buildings?.projects?.id || null;
      const uBuildingId = unit.floors?.sections?.buildings?.id || null;
      if (refBuildingId && uBuildingId === refBuildingId) {
        score += 25;
        matchReasons.push('Тот же корпус');
      } else if (refProjectId && uProjectId === refProjectId) {
        score += 15;
        matchReasons.push('Тот же жилой комплекс');
      }

      // 3. Area similarity
      if (refAreaM2 > 0) {
        const areaDiffPercent = Math.abs(areaM2 - refAreaM2) / refAreaM2;
        const areaScore = Math.max(0, Math.round((1 - areaDiffPercent) * 20));
        score += areaScore;
        const diffSign = areaM2 >= refAreaM2 ? '+' : '';
        matchReasons.push(`Площадь: ${areaM2.toFixed(1)} м² (${diffSign}${(areaM2 - refAreaM2).toFixed(1)} м²)`);
      }

      // 4. Price similarity
      if (refTotalPrice > 0 && totalPrice > 0) {
        const priceDiffPercent = Math.abs(totalPrice - refTotalPrice) / refTotalPrice;
        const priceScore = Math.max(0, Math.round((1 - priceDiffPercent) * 15));
        score += priceScore;
        const diffSign = totalPrice >= refTotalPrice ? '+' : '';
        matchReasons.push(`Бюджет: $${totalPrice.toLocaleString()} (${diffSign}$${(totalPrice - refTotalPrice).toLocaleString()})`);
      }

      scoredCandidates.push({
        id: unit.id,
        unit_number: unit.unit_number,
        rooms,
        areaM2,
        pricePerM2,
        totalPrice,
        status: unit.status,
        floor_number: unit.floors?.floor_number,
        section_name: unit.floors?.sections?.name,
        building_name: unit.floors?.sections?.buildings?.name || 'Блок Б',
        project_name: unit.floors?.sections?.buildings?.projects?.name || 'TOZON PLAZA',
        plan_image_url: unit.layout_types?.image_path || null,
        layout_name: unit.layout_types?.name || null,
        matchScore: Math.min(100, score),
        matchReasons,
        isAdvisoryOnly: true
      });
    }

    // Sort by matchScore descending, then area closeness
    scoredCandidates.sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return Math.abs(a.areaM2 - refAreaM2) - Math.abs(b.areaM2 - refAreaM2);
    });

    return scoredCandidates.slice(0, maxResults);
  }

  /**
   * Retrieves alternative units for a lead's interested units,
   * specifically focusing on units that are now SOLD, RESERVED, or BLOCKED.
   */
  static async getAlternativeUnitsForLead(leadId) {
    const cleanLeadId = Number(leadId);
    if (!cleanLeadId || isNaN(cleanLeadId)) {
      throw new AppError('Некорректный идентификатор лида', 400);
    }

    const interested = await LeadsRepository.getInterestedUnits(cleanLeadId);
    if (!interested || interested.length === 0) {
      return {
        lead_id: cleanLeadId,
        interested_units: [],
        has_unavailable_interests: false,
        recommendations_count: 0
      };
    }

    let hasUnavailable = false;
    let totalRecommendations = 0;

    const enrichedInterests = await Promise.all(
      interested.map(async (item) => {
        const unit = item.unit;
        const isUnavailable = !unit || ['SOLD', 'RESERVED', 'BLOCKED'].includes(unit.status);

        if (isUnavailable && unit) {
          hasUnavailable = true;
          const alternatives = await this.getAlternativesForUnit(unit.id, { limit: 4 });
          totalRecommendations += alternatives.length;
          return {
            ...item,
            is_unavailable: true,
            status_warning: unit.status === 'SOLD' ? 'Квартира уже продана' : 'Квартира забронирована другим покупателем',
            alternatives
          };
        }

        return {
          ...item,
          is_unavailable: false,
          alternatives: []
        };
      })
    );

    return {
      lead_id: cleanLeadId,
      interested_units: enrichedInterests,
      has_unavailable_interests: hasUnavailable,
      recommendations_count: totalRecommendations
    };
  }

  /**
   * Supervisor & Manager Win-Back Opportunities:
   * Finds leads whose desired apartments were SOLD or RESERVED by someone else,
   * but where available matching alternative inventory exists in the catalog.
   */
  static async getWinBackOpportunities(user) {
    if (!user) throw new AppError('Не авторизован', 401);
    if (['FINANCE_MANAGER', 'WAREHOUSE_MANAGER'].includes(user.role)) {
      throw new AppError('Доступ к возможностям возврата клиентов запрещен для вашей роли', 403);
    }

    const isSupervisor = ['ADMIN', 'DIRECTOR'].includes(user.role);
    const userId = Number(user.id);

    const db = getDB();

    // Query leads with interested units
    let leadsQuery = db
      .from('leads')
      .select(`
        id,
        full_name,
        phone,
        status,
        responsible_user_id,
        created_at,
        updated_at,
        users!responsible_user_id ( id, name )
      `)
      .in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION', 'LOST'])
      .is('archived_at', null)
      .order('updated_at', { ascending: false });

    if (!isSupervisor) {
      leadsQuery = leadsQuery.eq('responsible_user_id', userId);
    }

    const { data: leads, error } = await leadsQuery;
    if (error || !leads) {
      return [];
    }

    const opportunities = [];

    for (const lead of leads) {
      try {
        const leadAlt = await this.getAlternativeUnitsForLead(lead.id);
        if (leadAlt.has_unavailable_interests && leadAlt.recommendations_count > 0) {
          const unavailableUnits = leadAlt.interested_units.filter(u => u.is_unavailable);
          opportunities.push({
            lead_id: lead.id,
            lead_name: lead.full_name || 'Клиент',
            lead_phone: lead.phone || '',
            lead_status: lead.status,
            manager_id: lead.responsible_user_id,
            manager_name: lead.users?.name || 'Не назначен',
            unavailable_units_count: unavailableUnits.length,
            unavailable_units: unavailableUnits.map(u => ({
              unit_id: u.unit?.id,
              unit_number: u.unit?.unit_number,
              status: u.unit?.status,
              rooms: u.unit?.rooms,
              areaM2: u.unit?.areaM2,
              alternatives_count: (u.alternatives || []).length,
              best_alternative: u.alternatives?.[0] || null
            })),
            total_matching_alternatives: leadAlt.recommendations_count
          });
        }
      } catch (err) {
        // Skip individual lead on query error
        console.warn(`[AlternativeUnitsService] Lead ${lead.id} winback evaluation skipped:`, err.message);
      }
    }

    return opportunities;
  }
}
