import { getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class Tour360Repository {
  /**
   * Helper to generate a signed read URL from Supabase Storage bucket
   */
  static async getSignedReadUrl(bucket, storagePath, expiresIn = 86400) {
    if (!storagePath) return null;
    try {
      const db = getDB();
      const { data, error } = await db.storage.from(bucket).createSignedUrl(storagePath, expiresIn);
      if (error) {
        console.warn(`[Tour360] Failed to generate signed URL for ${bucket}/${storagePath}:`, error.message);
        return null;
      }
      return data?.signedUrl || null;
    } catch (e) {
      console.warn(`[Tour360] Exception generating signed URL for ${storagePath}:`, e.message);
      return null;
    }
  }

  /**
   * Validate that an entity belongs to a project
   */
  static async validateEntityBelongsToProject(projectId, entityType, entityId) {
    if (!entityType || !entityId) return true;
    const db = getDB();
    const pId = parseInt(projectId, 10);
    const eId = parseInt(entityId, 10);

    if (entityType === 'UNIT') {
      const { data } = await db.from('units')
        .select('id, floors!inner(sections!inner(buildings!inner(project_id)))')
        .eq('id', eId)
        .maybeSingle();
      if (!data || data.floors?.sections?.buildings?.project_id !== pId) {
        throw new AppError(`Квартира ID ${eId} не найдена в данном проекте`, 400);
      }
      return true;
    }

    if (entityType === 'BUILDING') {
      const { data } = await db.from('buildings').select('id, project_id').eq('id', eId).maybeSingle();
      if (!data || data.project_id !== pId) {
        throw new AppError(`Корпус ID ${eId} не найден в данном проекте`, 400);
      }
      return true;
    }

    if (entityType === 'FLOOR') {
      const { data } = await db.from('floors')
        .select('id, sections!inner(buildings!inner(project_id))')
        .eq('id', eId)
        .maybeSingle();
      if (!data || data.sections?.buildings?.project_id !== pId) {
        throw new AppError(`Этаж ID ${eId} не найден в данном проекте`, 400);
      }
      return true;
    }

    return true;
  }

  /**
   * Find tours for a project
   */
  static async findToursByProjectId(projectId, filters = {}) {
    const db = getDB();
    let query = db.from('tours_360')
      .select('*, panorama_360(id, name, thumbnail_path)')
      .eq('project_id', projectId)
      .order('is_active', { ascending: false })
      .order('created_at', { ascending: false });

    if (filters.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active === 'true' || filters.is_active === true);
    }
    if (filters.tour_type) {
      query = query.eq('tour_type', filters.tour_type);
    }

    const { data, error } = await query;
    if (error) throw error;

    return (data || []).map(tour => ({
      ...tour,
      panoramas_count: tour.panorama_360?.length || 0,
      panorama_360: undefined
    }));
  }

  /**
   * Get full tour hierarchy with all panoramas and hotspots
   */
  static async getTourTree(tourId) {
    const db = getDB();
    const { data: tour, error: tErr } = await db.from('tours_360')
      .select('*, projects(id, name, code, currency)')
      .eq('id', tourId)
      .single();

    if (tErr || !tour) throw new AppError('360 тур не найден', 404);

    const { data: panoramas, error: pErr } = await db.from('panorama_360')
      .select('*, panorama_hotspots:panorama_hotspots!panorama_hotspots_panorama_id_fkey(*)')
      .eq('tour_id', tourId)
      .order('sort_order')
      .order('id');

    if (pErr) throw pErr;

    // Attach signed read URLs for panoramas and thumbnails
    const panoramasWithUrls = await Promise.all((panoramas || []).map(async (p) => {
      const imageUrl = await this.getSignedReadUrl('panoramas-360', p.storage_path);
      const thumbUrl = p.thumbnail_path ? await this.getSignedReadUrl('panoramas-360', p.thumbnail_path) : imageUrl;
      
      const hotspots = (p.panorama_hotspots || []).map(h => ({
        id: h.id,
        panorama_id: h.panorama_id,
        hotspot_type: h.hotspot_type,
        yaw: parseFloat(h.yaw),
        pitch: parseFloat(h.pitch),
        label: h.label,
        target_panorama_id: h.target_panorama_id,
        target_entity_type: h.target_entity_type,
        target_entity_id: h.target_entity_id,
        metadata: h.metadata || {},
        created_at: h.created_at,
        updated_at: h.updated_at
      }));

      return {
        id: p.id,
        tour_id: p.tour_id,
        name: p.name,
        title: p.name,
        storage_path: p.storage_path,
        image_url: imageUrl,
        panorama_url: imageUrl,
        thumbnail_url: thumbUrl,
        entity_type: p.entity_type,
        entity_id: p.entity_id,
        initial_yaw: parseFloat(p.initial_yaw || 0),
        initial_pitch: parseFloat(p.initial_pitch || 0),
        initial_fov: parseFloat(p.initial_fov || 75),
        sort_order: p.sort_order,
        hotspots,
        created_at: p.created_at,
        updated_at: p.updated_at
      };
    }));

    return {
      ...tour,
      project_name: tour.projects?.name,
      project_code: tour.projects?.code,
      project_currency: tour.projects?.currency,
      projects: undefined,
      panoramas: panoramasWithUrls
    };
  }

  /**
   * Create a 360 tour
   */
  static async createTour(projectId, data) {
    const db = getDB();
    const now = new Date().toISOString();

    const { data: project, error: pErr } = await db.from('projects').select('id').eq('id', projectId).single();
    if (pErr || !project) throw new AppError('Проект не найден', 404);

    if (data.entity_type && data.entity_id) {
      await this.validateEntityBelongsToProject(projectId, data.entity_type, data.entity_id);
    }

    const { data: newTour, error } = await db.from('tours_360').insert([{
      project_id: projectId,
      name: data.name.trim(),
      tour_type: data.tour_type,
      entity_type: data.entity_type || null,
      entity_id: data.entity_id || null,
      is_active: data.is_active !== undefined ? data.is_active : true,
      created_at: now,
      updated_at: now
    }]).select().single();

    if (error) throw error;
    return this.getTourTree(newTour.id);
  }

  /**
   * Update tour
   */
  static async updateTour(tourId, data) {
    const db = getDB();
    const now = new Date().toISOString();
    const { data: existing } = await db.from('tours_360').select('id, project_id').eq('id', tourId).single();
    if (!existing) throw new AppError('360 тур не найден', 404);

    if (data.entity_type && data.entity_id) {
      await this.validateEntityBelongsToProject(existing.project_id, data.entity_type, data.entity_id);
    }

    const { data: updated, error } = await db.from('tours_360')
      .update({ ...data, updated_at: now })
      .eq('id', tourId)
      .select()
      .single();

    if (error) throw error;
    return this.getTourTree(updated.id);
  }

  /**
   * Delete tour
   */
  static async deleteTour(tourId) {
    const db = getDB();
    const { error } = await db.from('tours_360').delete().eq('id', tourId);
    if (error) throw error;
    return true;
  }

  /**
   * Get panoramas of a tour
   */
  static async getPanoramas(tourId) {
    const db = getDB();
    const { data: panoramas, error } = await db.from('panorama_360')
      .select('*, panorama_hotspots:panorama_hotspots!panorama_hotspots_panorama_id_fkey(*)')
      .eq('tour_id', tourId)
      .order('sort_order');

    if (error) throw error;

    return Promise.all((panoramas || []).map(async (p) => {
      const imageUrl = await this.getSignedReadUrl('panoramas-360', p.storage_path);
      return {
        ...p,
        image_url: imageUrl,
        initial_yaw: parseFloat(p.initial_yaw || 0),
        initial_pitch: parseFloat(p.initial_pitch || 0),
        initial_fov: parseFloat(p.initial_fov || 75),
        hotspots: p.panorama_hotspots || []
      };
    }));
  }

  /**
   * Create panorama in a tour
   */
  static async createPanorama(tourId, data) {
    const db = getDB();
    const now = new Date().toISOString();
    const tId = parseInt(tourId, 10);
    const { data: tour } = await db.from('tours_360').select('id, project_id').eq('id', tId).single();
    if (!tour) throw new AppError('360 тур не найден', 404);

    if (data.entity_type && data.entity_id) {
      await this.validateEntityBelongsToProject(tour.project_id, data.entity_type, data.entity_id);
    }

    const { data: newPano, error } = await db.from('panorama_360').insert([{
      tour_id: tId,
      name: (data.name || data.title || 'Панорама').trim(),
      storage_path: data.storage_path.trim(),
      thumbnail_path: data.thumbnail_path ? data.thumbnail_path.trim() : null,
      entity_type: data.entity_type || null,
      entity_id: data.entity_id ? parseInt(data.entity_id, 10) : null,
      initial_yaw: data.initial_yaw || 0,
      initial_pitch: data.initial_pitch || 0,
      initial_fov: data.initial_fov || 75,
      sort_order: data.sort_order || 0,
      created_at: now,
      updated_at: now
    }]).select().single();

    if (error) throw error;
    const imageUrl = await this.getSignedReadUrl('panoramas-360', newPano.storage_path);
    return { ...newPano, image_url: imageUrl, panorama_url: imageUrl, title: newPano.name, hotspots: [] };
  }

  /**
   * Update panorama
   */
  static async updatePanorama(panoramaId, data) {
    const db = getDB();
    const now = new Date().toISOString();
    const pId = parseInt(panoramaId, 10);
    const { data: existing } = await db.from('panorama_360').select('*, tours_360(project_id)').eq('id', pId).maybeSingle();
    if (!existing) throw new AppError('Панорама не найдена', 404);

    if (data.entity_type && data.entity_id) {
      await this.validateEntityBelongsToProject(existing.tours_360?.project_id, data.entity_type, data.entity_id);
    }

    const { data: updated, error } = await db.from('panorama_360')
      .update({ ...data, updated_at: now })
      .eq('id', pId)
      .select()
      .single();

    if (error) throw error;
    const imageUrl = await this.getSignedReadUrl('panoramas-360', updated.storage_path);
    return { ...updated, image_url: imageUrl, panorama_url: imageUrl, title: updated.name };
  }

  /**
   * Delete panorama
   */
  static async deletePanorama(panoramaId) {
    const db = getDB();
    const pId = parseInt(panoramaId, 10);
    const { error } = await db.from('panorama_360').delete().eq('id', pId);
    if (error) throw error;
    return true;
  }

  /**
   * Get hotspots of a panorama
   */
  static async getHotspots(panoramaId) {
    const db = getDB();
    const pId = parseInt(panoramaId, 10);
    const { data, error } = await db.from('panorama_hotspots')
      .select('*')
      .eq('panorama_id', pId);

    if (error) throw error;
    return (data || []).map(h => ({
      ...h,
      yaw: parseFloat(h.yaw),
      pitch: parseFloat(h.pitch)
    }));
  }

  /**
   * Create hotspot on panorama
   */
  static async createHotspot(panoramaId, data) {
    const db = getDB();
    const now = new Date().toISOString();
    const pId = parseInt(panoramaId, 10);

    const { data: pano, error: pErr } = await db.from('panorama_360')
      .select('id, tour_id')
      .eq('id', pId)
      .maybeSingle();

    if (pErr || !pano) throw new AppError('Панорама не найдена', 404);

    // If NAVIGATION hotspot, verify target panorama belongs to the SAME tour
    if (data.hotspot_type === 'NAVIGATION') {
      if (!data.target_panorama_id) {
        throw new AppError('Для навигационного хотспота обязательно указать target_panorama_id', 400);
      }
      const targetPanoId = parseInt(data.target_panorama_id, 10);
      const { data: targetPano } = await db.from('panorama_360')
        .select('id, tour_id')
        .eq('id', targetPanoId)
        .maybeSingle();

      if (!targetPano) {
        throw new AppError(`Целевая панорама ID ${data.target_panorama_id} не существует`, 404);
      }
      if (parseInt(targetPano.tour_id, 10) !== parseInt(pano.tour_id, 10)) {
        throw new AppError('Целевая панорама должна принадлежать тому же 360-туру', 400);
      }
    }

    // Validate target entity if provided
    if (data.target_entity_type && data.target_entity_id) {
      const { data: tour } = await db.from('tours_360').select('project_id').eq('id', pano.tour_id).maybeSingle();
      if (tour) {
        await this.validateEntityBelongsToProject(tour.project_id, data.target_entity_type, data.target_entity_id);
      }
    }

    const { data: newHotspot, error } = await db.from('panorama_hotspots').insert([{
      panorama_id: pId,
      hotspot_type: data.hotspot_type,
      yaw: data.yaw,
      pitch: data.pitch,
      label: (data.label || data.title) ? (data.label || data.title).trim() : null,
      target_panorama_id: data.target_panorama_id ? parseInt(data.target_panorama_id, 10) : null,
      target_entity_type: data.target_entity_type || data.entity_type || null,
      target_entity_id: data.target_entity_id ? parseInt(data.target_entity_id, 10) : null,
      metadata: data.metadata || {},
      created_at: now,
      updated_at: now
    }]).select().single();

    if (error) throw error;
    return {
      ...newHotspot,
      yaw: parseFloat(newHotspot.yaw),
      pitch: parseFloat(newHotspot.pitch)
    };
  }

  /**
   * Update hotspot
   */
  static async updateHotspot(hotspotId, data) {
    const db = getDB();
    const now = new Date().toISOString();
    const hId = parseInt(hotspotId, 10);

    const { data: existing, error: findErr } = await db.from('panorama_hotspots')
      .select('*')
      .eq('id', hId)
      .maybeSingle();

    if (findErr || !existing) throw new AppError('Хотспот не найден', 404);

    const targetType = data.hotspot_type || existing.hotspot_type;
    const targetPanoId = data.target_panorama_id !== undefined ? data.target_panorama_id : existing.target_panorama_id;

    if (targetType === 'NAVIGATION' && targetPanoId && data.target_panorama_id !== undefined) {
      const { data: currentPano } = await db.from('panorama_360')
        .select('id, tour_id')
        .eq('id', existing.panorama_id)
        .maybeSingle();

      const { data: targetPano } = await db.from('panorama_360')
        .select('id, tour_id')
        .eq('id', parseInt(targetPanoId, 10))
        .maybeSingle();

      if (!targetPano || (currentPano && parseInt(targetPano.tour_id, 10) !== parseInt(currentPano.tour_id, 10))) {
        throw new AppError('Целевая панорама должна принадлежать тому же 360-туру', 400);
      }
    }

    const { data: updated, error } = await db.from('panorama_hotspots')
      .update({ ...data, updated_at: now })
      .eq('id', hId)
      .select()
      .single();

    if (error) throw error;
    return {
      ...updated,
      yaw: parseFloat(updated.yaw),
      pitch: parseFloat(updated.pitch)
    };
  }

  /**
   * Delete hotspot
   */
  static async deleteHotspot(hotspotId) {
    const db = getDB();
    const hId = parseInt(hotspotId, 10);
    const { error } = await db.from('panorama_hotspots').delete().eq('id', hId);
    if (error) throw error;
    return true;
  }

  /**
   * Generate secure presigned upload URL for 360 panorama image
   */
  static async generateUploadUrl(projectId, { tourId, filename, fileSizeBytes }) {
    const db = getDB();
    const pId = parseInt(projectId, 10);

    const { data: project } = await db.from('projects').select('id').eq('id', pId).single();
    if (!project) throw new AppError('Проект не найден', 404);

    const cleanFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const tId = tourId || 'new';
    const storagePath = `projects/${pId}/360/${tId}/${timestamp}_${cleanFilename}`;

    try {
      const { data, error } = await db.storage.from('panoramas-360').createSignedUploadUrl(storagePath);
      if (error) {
        return {
          bucket: 'panoramas-360',
          storagePath,
          storage_path: storagePath,
          signedUrl: null,
          signedUploadUrl: null,
          uploadUrl: null
        };
      }

      return {
        bucket: 'panoramas-360',
        storagePath,
        storage_path: storagePath,
        signedUrl: data?.signedUrl,
        signedUploadUrl: data?.signedUrl,
        uploadUrl: data?.signedUrl,
        token: data?.token
      };
    } catch (e) {
      return {
        bucket: 'panoramas-360',
        storagePath,
        storage_path: storagePath,
        signedUrl: null,
        signedUploadUrl: null,
        uploadUrl: null
      };
    }
  }
}

