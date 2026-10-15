import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const DRAFT_BUCKET = 'panoramas-360-drafts';
const PUBLISHED_BUCKET = 'panoramas-360';

export class Tour360Repository {
  /**
   * Helper to generate a signed read URL from Supabase Storage bucket
   */
  static async getSignedReadUrl(bucket, storagePath, expiresIn = 86400) {
    if (!storagePath) return null;
    // Draft URLs must be short-lived even when a caller requests a longer lifetime.
    const safeExpiry = bucket === DRAFT_BUCKET ? Math.min(300, Math.max(1, Number(expiresIn) || 300)) : expiresIn;
    try {
      const db = getServiceDB();
      const { data, error } = await db.storage.from(bucket).createSignedUrl(storagePath, safeExpiry);
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
      const bucket = tour.is_active ? PUBLISHED_BUCKET : DRAFT_BUCKET;
      const imageUrl = await this.getSignedReadUrl(bucket, p.storage_path);
      const thumbUrl = p.thumbnail_path ? await this.getSignedReadUrl(bucket, p.thumbnail_path) : imageUrl;
      
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
      is_active: false, // New tours always begin as private drafts; activation requires verified publish.
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
    const { data: existing } = await db.from('tours_360').select('id, project_id, is_active').eq('id', tourId).single();
    if (!existing) throw new AppError('360 тур не найден', 404);
    await this.assertDraftTourEditable(tourId);
    // Never switch storage buckets implicitly: a published tour must not point at private draft files.
    if (data.is_active !== undefined) {
      throw new AppError('Публикация черновика недоступна до безопасного переноса панорам в публичное хранилище', 409);
    }

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
   * Read-only publication preflight. Does not copy files or activate a tour.
   * A separate, transactional publish operation is required before release.
   */
  static async getPublishPreflight(tourId) {
    const db = getServiceDB();
    const { data: tour, error: tourError } = await db.from('tours_360')
      .select('id, project_id, is_active').eq('id', tourId).maybeSingle();
    if (tourError) throw tourError;
    if (!tour) throw new AppError('360 тур не найден', 404);
    if (tour.is_active) throw new AppError('Тур уже опубликован', 409);

    const { data: panoramas, error: panoramaError } = await db.from('panorama_360')
      .select('id, name, storage_path, thumbnail_path').eq('tour_id', tourId).order('id');
    if (panoramaError) throw panoramaError;
    const expectedPrefix = `projects/${tour.project_id}/360/${tour.id}/`;
    const files = (panoramas || []).flatMap(p => [p.storage_path, p.thumbnail_path].filter(Boolean));
    const invalidPaths = files.filter(path => typeof path !== 'string' || !path.startsWith(expectedPrefix) || path.includes('..'));
    const missing = [];
    for (const path of new Set(files.filter(p => typeof p === 'string' && p.startsWith(expectedPrefix)))) {
      const segments = path.slice(expectedPrefix.length).split('/');
      const filename = segments.pop();
      const folder = [expectedPrefix.replace(/\/$/, ''), ...segments].filter(Boolean).join('/');
      const { data, error } = await db.storage.from(DRAFT_BUCKET).list(folder, { search: filename, limit: 100 });
      if (error || !(data || []).some(object => object.name === filename)) missing.push(path);
    }
    return {
      tour_id: tour.id,
      project_id: tour.project_id,
      panorama_count: (panoramas || []).length,
      file_count: files.length,
      invalid_paths: invalidPaths,
      missing_or_unreadable: missing,
      ready_for_publish: files.length > 0 && invalidPaths.length === 0 && missing.length === 0,
      published: false,
      note: 'Только предварительная проверка. Файлы не переносились, тур не опубликован.'
    };
  }

  /**
   * Prepare a deterministic, read-only publication manifest.
   * No storage writes, database updates or activation occur here.
   */
  static async getPublishManifest(tourId) {
    const preflight = await this.getPublishPreflight(tourId);
    const db = getServiceDB();
    const { data: panoramas, error } = await db.from('panorama_360')
      .select('id, storage_path, thumbnail_path').eq('tour_id', tourId).order('id');
    if (error) throw error;
    const files = [...new Set((panoramas || []).flatMap(p => [p.storage_path, p.thumbnail_path].filter(Boolean)))];
    return {
      ...preflight,
      source_bucket: DRAFT_BUCKET,
      destination_bucket: PUBLISHED_BUCKET,
      files: files.map(path => ({ source_path: path, destination_path: path })),
      can_execute: false,
      note: 'План только для чтения. Копирование и активация не выполняются.'
    };
  }

  /**
   * Delete tour
   */
  static async deleteTour(tourId) {
    await this.assertDraftTourEditable(tourId);
    const db = getDB();
    const { error } = await db.from('tours_360').delete().eq('id', tourId);
    if (error) throw error;
    return true;
  }

  /** Load one panorama only after its owning tour is authorized by the router. */
  static async getPanoramaById(panoramaId) {
    const db = getServiceDB();
    const { data: panorama, error } = await db.from('panorama_360')
      .select('*').eq('id', panoramaId).maybeSingle();
    if (error) throw error;
    if (!panorama) throw new AppError('Панорама не найдена', 404);
    const { data: tour, error: tourError } = await db.from('tours_360')
      .select('is_active').eq('id', panorama.tour_id).maybeSingle();
    if (tourError) throw tourError;
    if (!tour) throw new AppError('Тур не найден', 404);
    const bucket = tour.is_active ? PUBLISHED_BUCKET : DRAFT_BUCKET;
    const imageUrl = await this.getSignedReadUrl(bucket, panorama.storage_path);
    return { ...panorama, is_tour_active: tour.is_active, image_url: imageUrl, panorama_url: imageUrl };
  }

  /**
   * Get panoramas of a tour
   */
  static async getPanoramas(tourId) {
    const db = getDB();
    const { data: tour } = await db.from('tours_360').select('id, is_active').eq('id', tourId).maybeSingle();
    if (!tour) throw new AppError('360 тур не найден', 404);
    const bucket = tour.is_active ? PUBLISHED_BUCKET : DRAFT_BUCKET;
    const { data: panoramas, error } = await db.from('panorama_360')
      .select('*, panorama_hotspots:panorama_hotspots!panorama_hotspots_panorama_id_fkey(*)')
      .eq('tour_id', tourId)
      .order('sort_order');

    if (error) throw error;

    return Promise.all((panoramas || []).map(async (p) => {
      const imageUrl = await this.getSignedReadUrl(bucket, p.storage_path);
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
    const { data: tour } = await db.from('tours_360').select('id, project_id, is_active').eq('id', tId).single();
    if (!tour) throw new AppError('360 тур не найден', 404);
    if (tour.is_active) throw new AppError('Изменять опубликованный тур запрещено', 409);
    const expectedPrefix = `projects/${tour.project_id}/360/${tId}/`;
    if (typeof data.storage_path !== 'string' || !data.storage_path.startsWith(expectedPrefix) || data.storage_path.includes('..')) throw new AppError('Путь панорамы не принадлежит черновику тура', 400);

    const filename = data.storage_path.slice(expectedPrefix.length);
    if (!filename || filename.includes('/') || !/^[0-9]+_[A-Za-z0-9._-]+\.(?:jpe?g|webp)$/i.test(filename)) {
      throw new AppError('Некорректный путь панорамы: требуется файл из подписанной загрузки', 400);
    }
    if (data.thumbnail_path) {
      throw new AppError('Отдельная миниатюра пока не поддерживается для закрытых черновиков', 400);
    }
    const { data: uploadedFiles, error: storageError } = await getServiceDB().storage
      .from(DRAFT_BUCKET).list(expectedPrefix.replace(/\/$/, ''), { search: filename, limit: 100 });
    if (storageError) throw new AppError('Не удалось проверить загруженный файл', 503);
    if (!(uploadedFiles || []).some(file => file.name === filename)) {
      throw new AppError('Файл панорамы ещё не загружен в защищённое хранилище', 409);
    }

    const roomName = (data.name || data.title || 'Панорама').trim();
    const { data: duplicates, error: duplicateError } = await db.from('panorama_360')
      .select('id, name, storage_path').eq('tour_id', tId);
    if (duplicateError) throw duplicateError;
    if ((duplicates || []).some(p => p.name === roomName || p.storage_path === data.storage_path)) {
      throw new AppError('Это помещение или файл уже добавлены в черновик тура', 409);
    }

    if (data.entity_type && data.entity_id) {
      await this.validateEntityBelongsToProject(tour.project_id, data.entity_type, data.entity_id);
    }

    const { data: newPano, error } = await db.from('panorama_360').insert([{
      tour_id: tId,
      name: roomName,
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
    const imageUrl = await this.getSignedReadUrl(DRAFT_BUCKET, newPano.storage_path);
    return { ...newPano, image_url: imageUrl, panorama_url: imageUrl, title: newPano.name, hotspots: [] };
  }

  /**
   * Update panorama
   */
  static async updatePanorama(panoramaId, data) {
    await this.assertDraftPanoramaEditable(panoramaId);
    const db = getDB();
    const now = new Date().toISOString();
    const pId = parseInt(panoramaId, 10);
    const { data: existing } = await db.from('panorama_360').select('*, tours_360(project_id)').eq('id', pId).maybeSingle();
    if (!existing) throw new AppError('Панорама не найдена', 404);

    if (data.storage_path !== undefined || data.thumbnail_path !== undefined || data.tour_id !== undefined || data.id !== undefined) {
      throw new AppError('Пути файлов и принадлежность панорамы нельзя менять через обычное редактирование', 409);
    }

    if (data.entity_type && data.entity_id) {
      await this.validateEntityBelongsToProject(existing.tours_360?.project_id, data.entity_type, data.entity_id);
    }

    const { data: updated, error } = await db.from('panorama_360')
      .update({ ...data, updated_at: now })
      .eq('id', pId)
      .select()
      .single();

    if (error) throw error;
    const { data: owningTour } = await db.from('tours_360').select('is_active').eq('id', updated.tour_id).maybeSingle();
    const imageUrl = await this.getSignedReadUrl(owningTour?.is_active ? PUBLISHED_BUCKET : DRAFT_BUCKET, updated.storage_path);
    return { ...updated, image_url: imageUrl, panorama_url: imageUrl, title: updated.name };
  }

  /**
   * Delete panorama
   */
  static async deletePanorama(panoramaId) {
    await this.assertDraftPanoramaEditable(panoramaId);
    const db = getDB();
    const pId = parseInt(panoramaId, 10);
    const { error } = await db.from('panorama_360').delete().eq('id', pId);
    if (error) throw error;
    return true;
  }

  /** Return owning tour visibility without signing or exposing private images. */
  static async getPanoramaTourVisibility(panoramaId) {
    const db = getServiceDB();
    const { data: panorama, error } = await db.from('panorama_360')
      .select('tour_id').eq('id', panoramaId).maybeSingle();
    if (error) throw error;
    if (!panorama) return null;
    const { data: tour, error: tourError } = await db.from('tours_360')
      .select('is_active').eq('id', panorama.tour_id).maybeSingle();
    if (tourError) throw tourError;
    return tour;
  }

  /** Only draft tours can be edited via regular CRUD routes. */
  static async assertDraftTourEditable(tourId) {
    const db = getServiceDB();
    const { data: tour, error } = await db.from('tours_360').select('is_active').eq('id', tourId).maybeSingle();
    if (error) throw error;
    if (!tour) throw new AppError('Тур не найден', 404);
    if (tour.is_active !== false) throw new AppError('Изменять опубликованный тур запрещено', 409);
  }

  static async assertDraftPanoramaEditable(panoramaId) {
    const db = getServiceDB();
    const { data: panorama, error } = await db.from('panorama_360').select('tour_id').eq('id', panoramaId).maybeSingle();
    if (error) throw error;
    if (!panorama) throw new AppError('Панорама не найдена', 404);
    await this.assertDraftTourEditable(panorama.tour_id);
  }

  static async assertDraftHotspotEditable(hotspotId) {
    const db = getServiceDB();
    const { data: hotspot, error } = await db.from('panorama_hotspots').select('panorama_id').eq('id', hotspotId).maybeSingle();
    if (error) throw error;
    if (!hotspot) throw new AppError('Хотспот не найден', 404);
    await this.assertDraftPanoramaEditable(hotspot.panorama_id);
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
    await this.assertDraftPanoramaEditable(panoramaId);
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
    await this.assertDraftHotspotEditable(hotspotId);
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
    await this.assertDraftHotspotEditable(hotspotId);
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
    const db = getServiceDB();
    const pId = parseInt(projectId, 10);

    const { data: project } = await db.from('projects').select('id').eq('id', pId).single();
    if (!project) throw new AppError('Проект не найден', 404);

    if (!tourId) throw new AppError('tourId обязателен для безопасной загрузки', 400);
    const { data: targetTour, error: tourError } = await db.from('tours_360').select('id, project_id, is_active').eq('id', tourId).maybeSingle();
    if (tourError || !targetTour || Number(targetTour.project_id) !== pId) throw new AppError('Тур не принадлежит проекту', 403);
    if (targetTour.is_active) throw new AppError('Загрузка доступна только в неопубликованный тур', 409);

    if (typeof filename !== 'string' || !/\.(jpe?g|webp)$/i.test(filename)) {
      throw new AppError('Допустимы только JPG и WEBP панорамы', 400);
    }
    if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 1 || fileSizeBytes > 25 * 1024 * 1024) {
      throw new AppError('Размер панорамы должен быть от 1 байта до 25 МБ', 400);
    }
    const cleanFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const tId = tourId || 'new';
    const storagePath = `projects/${pId}/360/${tId}/${timestamp}_${cleanFilename}`;

    try {
      const { data, error } = await db.storage.from(DRAFT_BUCKET).createSignedUploadUrl(storagePath);
      if (error || !data?.signedUrl) {
        console.error('[Tour360] Draft storage unavailable:', error?.message || 'signed URL missing');
        throw new AppError('Защищённое хранилище панорам недоступно. Загрузка отменена.', 503);
      }
      return {
        bucket: DRAFT_BUCKET,
        storagePath,
        storage_path: storagePath,
        signedUrl: data.signedUrl,
        signedUploadUrl: data.signedUrl,
        uploadUrl: data.signedUrl,
        token: data.token
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      console.error('[Tour360] Failed to issue draft upload URL:', error?.message);
      throw new AppError('Защищённое хранилище панорам недоступно. Загрузка отменена.', 503);
    }
  }
}

