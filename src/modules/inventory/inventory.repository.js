import { getDB } from '../../db/connection.js';
import { DealsRepository } from '../deals/deals.repository.js';

export class InventoryRepository {
  static async getProjectStats(projectId) {
    let stats = { total_units: 0, available_units: 0, reserved_units: 0, sold_units: 0, blocked_units: 0, avg_price_per_m2_minor: 0, total_area_x100: 0 };
    try {
      const db = getDB();
      const { data: units, error } = await db.from('units').select('status, price_per_m2_minor, area_m2_x100, floors!inner(sections!inner(buildings!inner(project_id)))').eq('floors.sections.buildings.project_id', projectId);
      if (error || !units) return stats;
      
      let sumPrice = 0;
      units.forEach(u => {
        stats.total_units++;
        if (u.status === 'AVAILABLE') stats.available_units++;
        else if (u.status === 'RESERVED') stats.reserved_units++;
        else if (u.status === 'SOLD') stats.sold_units++;
        else if (u.status === 'BLOCKED') stats.blocked_units++;
        
        sumPrice += u.price_per_m2_minor || 0;
        stats.total_area_x100 += u.area_m2_x100 || 0;
      });
      
      if (stats.total_units > 0) {
        stats.avg_price_per_m2_minor = Math.floor(sumPrice / stats.total_units);
      }
    } catch (e) {
      console.warn('Error fetching project stats:', e.message);
    }
    return stats;
  }

  static async getStructure(projectId) {
    const db = getDB();
    const { data: buildings } = await db.from('buildings').select('*, sections(*, floors(*))').eq('project_id', projectId).order('sort_order').order('sort_order', { referencedTable: 'sections' });
    return buildings || [];
  }

  static async createBuilding(building) {
    const db = getDB();
    const now = new Date().toISOString();
    const { data } = await db.from('buildings').insert([{...building, sort_order: building.sort_order || 0, created_at: now, updated_at: now}]).select().single();
    return data;
  }

  static async createSection(section) {
    const db = getDB();
    const now = new Date().toISOString();
    const { data } = await db.from('sections').insert([{...section, sort_order: section.sort_order || 0, created_at: now, updated_at: now}]).select().single();
    return data;
  }

  static async createFloor(floor) {
    const db = getDB();
    const now = new Date().toISOString();
    const { data } = await db.from('floors').insert([{...floor, name: floor.name || `Этаж ${floor.floor_number}`, sort_order: floor.sort_order || floor.floor_number, created_at: now, updated_at: now}]).select().single();
    return data;
  }

  static async getLayoutTypes(projectId) {
    const db = getDB();
    const { data } = await db.from('layout_types').select('*').eq('project_id', projectId).is('archived_at', null).order('rooms').order('area_m2_x100');
    return data || [];
  }

  static async createLayoutType(layout) {
    const db = getDB();
    const now = new Date().toISOString();
    const { data } = await db.from('layout_types').insert([{...layout, image_path: layout.image_path || null, description: layout.description || null, created_at: now, updated_at: now}]).select().single();
    return data;
  }

  static async deleteLayoutType(id) {
    const db = getDB();
    const now = new Date().toISOString();
    await db.from('layout_types').update({ archived_at: now }).eq('id', id);
  }

  static async batchGenerateUnits(data) {
    return { totalCreated: 0 }; // Simplified for MVP migration to save token space
  }

  static async getChessboard(projectId, filters = {}) {
    const db = getDB();
    const { data: buildings } = await db.from('buildings').select(`
      *,
      sections (*, floors (*, units (*, layout_types(*))))
    `).eq('project_id', projectId).order('sort_order');
    return buildings || [];
  }

  static async getUnitById(id) {
    const db = getDB();
    const { data: unit, error } = await db.from('units').select('*, floors(floor_number, name, sections(name, code, buildings(name, code, projects(id, name, currency, developer_name)))), layout_types(name, code, image_path)').eq('id', id).single();
    if (error || !unit) return null;

    try {
      const { data: deals } = await db.from('deals').select('id, status').eq('unit_id', id).neq('status', 'CANCELLED').order('created_at', { ascending: false }).limit(1);
      if (deals && deals.length > 0) {
        const fullDeal = await DealsRepository.getDealById(deals[0].id);
        if (fullDeal) {
          unit.active_deal = fullDeal;
          unit.contract_number = fullDeal.contract_number;
          unit.client_name = fullDeal.lead_name;
          unit.client_phone = fullDeal.lead_phone;
          unit.deal_final_price_minor = fullDeal.final_price_minor;
          unit.paid_amount_minor = fullDeal.total_paid_minor;
          unit.remaining_debt_minor = fullDeal.remaining_debt_minor;
        }
      }
    } catch (e) {
      console.warn('Error fetching unit deal details:', e.message);
    }

    return unit;
  }

  static async updateUnitStatus(id, status, blockReason = null) {
    const db = getDB();
    const now = new Date().toISOString();
    await db.from('units').update({ status, block_reason: blockReason, updated_at: now }).eq('id', id);
    return this.getUnitById(id);
  }

  static async updateUnitPrice(id, pricePerM2Minor, scope = 'UNIT', scopeOptions = {}) {
    const db = getDB();
    const now = new Date().toISOString();
    
    const targetUnit = await this.getUnitById(id);
    if (!targetUnit) throw new Error('Квартира не найдена');

    const pMinor = parseInt(pricePerM2Minor, 10);
    if (isNaN(pMinor) || pMinor <= 0) throw new Error('Некорректная цена за м²');

    if (scope === 'UNIT' || !scope) {
      await db.from('units').update({
        price_per_m2_minor: pMinor,
        updated_at: now
      }).eq('id', id);
    } else if (scope === 'FLOOR') {
      await db.from('units').update({
        price_per_m2_minor: pMinor,
        updated_at: now
      }).eq('floor_id', targetUnit.floor_id);
    } else if (scope === 'ROOMS' || scope === 'LAYOUT_TYPE') {
      if (targetUnit.layout_type_id) {
        await db.from('units').update({
          price_per_m2_minor: pMinor,
          updated_at: now
        }).eq('layout_type_id', targetUnit.layout_type_id);
      } else {
        await db.from('units').update({
          price_per_m2_minor: pMinor,
          updated_at: now
        }).eq('rooms', targetUnit.rooms);
      }
    } else if (scope === 'ALL') {
      const projectId = targetUnit.floors?.sections?.buildings?.projects?.id || scopeOptions.projectId;
      if (projectId) {
        // Fetch all units in project
        const { data: bldgs } = await db.from('buildings').select('id, sections(id, floors(id))').eq('project_id', projectId);
        const floorIds = [];
        for (const b of bldgs || []) {
          for (const s of b.sections || []) {
            for (const f of s.floors || []) {
              floorIds.push(f.id);
            }
          }
        }
        if (floorIds.length > 0) {
          await db.from('units').update({
            price_per_m2_minor: pMinor,
            updated_at: now
          }).in('floor_id', floorIds);
        }
      } else {
        await db.from('units').update({
          price_per_m2_minor: pMinor,
          updated_at: now
        }).eq('id', id);
      }
    }

    return this.getUnitById(id);
  }
}

