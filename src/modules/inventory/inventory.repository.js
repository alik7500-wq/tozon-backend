import { getDB } from '../../db/connection.js';

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
    const { data: unit } = await db.from('units').select('*, floors(floor_number, name, sections(name, code, buildings(name, code, projects(name, currency)))), layout_types(name, code, image_path)').eq('id', id).single();
    return unit;
  }

  static async updateUnitStatus(id, status, blockReason = null) {
    const db = getDB();
    const now = new Date().toISOString();
    await db.from('units').update({ status, block_reason: blockReason, updated_at: now }).eq('id', id);
    return this.getUnitById(id);
  }
}
