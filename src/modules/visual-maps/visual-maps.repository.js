import { getDB } from '../../db/connection.js';

export class VisualMapsRepository {
  static async getByProjectId(projectId, kind = null) {
    const db = getDB();
    let query = db.from('visual_maps').select('*, map_hotspots(*, buildings(name), sections(name), floors(floor_number), units(unit_number, status))').eq('project_id', projectId).order('created_at', { ascending: false });

    if (kind) query = query.eq('kind', kind);

    const { data: maps, error } = await query;
    if (error) throw error;

    return (maps || []).map(m => {
      const hotspots = (m.map_hotspots || []).map(h => ({
        ...h,
        building_name: h.buildings?.name,
        section_name: h.sections?.name,
        floor_number: h.floors?.floor_number,
        unit_number: h.units?.unit_number,
        unit_status: h.units?.status,
        buildings: undefined, sections: undefined, floors: undefined, units: undefined
      })).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      return { ...m, hotspots, map_hotspots: undefined };
    });
  }

  static async createMap(mapData) {
    const db = getDB();
    const now = new Date().toISOString();
    const { data, error } = await db.from('visual_maps').insert([{
      ...mapData,
      building_id: mapData.building_id || null,
      section_id: mapData.section_id || null,
      floor_id: mapData.floor_id || null,
      image_width: mapData.image_width || null,
      image_height: mapData.image_height || null,
      created_at: now,
      updated_at: now,
    }]).select().single();
    if (error) throw error;
    return data;
  }

  static async deleteMap(id) {
    const db = getDB();
    await db.from('visual_maps').delete().eq('id', id);
  }

  static async saveHotspots(visualMapId, hotspots = []) {
    const db = getDB();
    const now = new Date().toISOString();
    
    await db.from('map_hotspots').delete().eq('visual_map_id', visualMapId);

    if (hotspots.length > 0) {
      const inserts = hotspots.map((h, i) => ({
        visual_map_id: visualMapId,
        target_building_id: h.target_building_id || null,
        target_section_id: h.target_section_id || null,
        target_floor_id: h.target_floor_id || null,
        target_unit_id: h.target_unit_id || null,
        x_pct: Math.max(0, Math.min(100, parseFloat(h.x_pct) || 0)),
        y_pct: Math.max(0, Math.min(100, parseFloat(h.y_pct) || 0)),
        width_pct: Math.max(1, Math.min(100, parseFloat(h.width_pct) || 10)),
        height_pct: Math.max(1, Math.min(100, parseFloat(h.height_pct) || 10)),
        label: h.label || '',
        sort_order: i,
        created_at: now,
        updated_at: now,
      }));
      await db.from('map_hotspots').insert(inserts);
    }
  }
}
