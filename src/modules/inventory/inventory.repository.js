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
    const db = getDB();
    const {
      projectId,
      buildingName = 'Блок А',
      buildingCode = 'БЛОК-А',
      sectionName = 'Секция 1',
      floorFrom = 1,
      floorTo = 10,
      numberPrefix = '',
      numberStart = 1,
      floorSlots = []
    } = data;

    if (!projectId) throw new Error('projectId обязателен');
    if (!floorSlots || floorSlots.length === 0) throw new Error('Не заданы слоты квартир на этаже');

    const now = new Date().toISOString();

    // 1. Find or create building
    let { data: building } = await db.from('buildings').select('*').eq('project_id', projectId).eq('name', buildingName).maybeSingle();
    if (!building) {
      const { data: newBuilding, error: bErr } = await db.from('buildings').insert([{
        project_id: projectId,
        name: buildingName,
        code: buildingCode || buildingName,
        sort_order: 1,
        created_at: now,
        updated_at: now
      }]).select().single();
      if (bErr) throw bErr;
      building = newBuilding;
    }

    // 2. Find or create section
    let { data: section } = await db.from('sections').select('*').eq('building_id', building.id).eq('name', sectionName).maybeSingle();
    if (!section) {
      const { data: newSection, error: sErr } = await db.from('sections').insert([{
        building_id: building.id,
        name: sectionName,
        code: sectionName,
        sort_order: 1,
        created_at: now,
        updated_at: now
      }]).select().single();
      if (sErr) throw sErr;
      section = newSection;
    }

    let currentNumber = parseInt(numberStart, 10) || 1;
    let totalCreated = 0;

    for (let fNum = parseInt(floorFrom, 10); fNum <= parseInt(floorTo, 10); fNum++) {
      let { data: floor } = await db.from('floors').select('*').eq('section_id', section.id).eq('floor_number', fNum).maybeSingle();
      if (!floor) {
        const { data: newFloor, error: fErr } = await db.from('floors').insert([{
          section_id: section.id,
          floor_number: fNum,
          name: `${fNum} этаж`,
          sort_order: fNum,
          created_at: now,
          updated_at: now
        }]).select().single();
        if (fErr) throw fErr;
        floor = newFloor;
      }

      for (const slot of floorSlots) {
        const unitNumber = `${numberPrefix || ''}${currentNumber++}`;
        const { error: uErr } = await db.from('units').insert([{
          floor_id: floor.id,
          layout_type_id: slot.layoutTypeId || null,
          unit_number: unitNumber,
          rooms: slot.rooms,
          area_m2_x100: slot.area_m2_x100,
          price_per_m2_minor: slot.price_per_m2_minor || 0,
          status: 'AVAILABLE',
          created_at: now,
          updated_at: now
        }]);
        if (uErr) {
          console.warn('Error inserting unit in batch generate:', uErr.message);
        } else {
          totalCreated++;
        }
      }
    }

    return { totalCreated };
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

  static async updateUnitsBatchPrice(unitIds, pricePerM2Minor) {
    const db = getDB();
    const now = new Date().toISOString();
    
    if (!Array.isArray(unitIds) || unitIds.length === 0) {
      throw new Error('Не выбраны квартиры для обновления цены');
    }

    const pMinor = parseInt(pricePerM2Minor, 10);
    if (isNaN(pMinor) || pMinor <= 0) throw new Error('Некорректная цена за м²');

    await db.from('units').update({
      price_per_m2_minor: pMinor,
      updated_at: now
    }).in('id', unitIds);

    return { updatedCount: unitIds.length };
  }

  static async updateUnitPrice(id, pricePerM2Minor, scope = 'UNIT', scopeOptions = {}) {
    const db = getDB();
    const now = new Date().toISOString();
    
    const targetUnit = await this.getUnitById(id);
    if (!targetUnit) throw new Error('Квартира не найдена');

    const pMinor = parseInt(pricePerM2Minor, 10);
    if (isNaN(pMinor) || pMinor <= 0) throw new Error('Некорректная цена за м²');

    if (scopeOptions?.unit_ids && Array.isArray(scopeOptions.unit_ids) && scopeOptions.unit_ids.length > 0) {
      await db.from('units').update({
        price_per_m2_minor: pMinor,
        updated_at: now
      }).in('id', scopeOptions.unit_ids);
    } else if (scope === 'UNIT' || !scope) {
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

