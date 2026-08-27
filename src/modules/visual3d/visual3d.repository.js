import { getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class Visual3DRepository {
  /**
   * Helper to generate a signed read URL from Supabase Storage bucket
   */
  static async getSignedReadUrl(bucket, storagePath, expiresIn = 86400) {
    if (!storagePath) return null;
    try {
      const db = getDB();
      const { data, error } = await db.storage.from(bucket).createSignedUrl(storagePath, expiresIn);
      if (error) {
        console.warn(`[Visual3D] Failed to generate signed URL for ${bucket}/${storagePath}:`, error.message);
        return null;
      }
      return data?.signedUrl || null;
    } catch (e) {
      console.warn(`[Visual3D] Exception generating signed URL for ${storagePath}:`, e.message);
      return null;
    }
  }

  /**
   * Find all scenes for a project
   */
  static async findByProjectId(projectId, filters = {}) {
    const db = getDB();
    let query = db.from('scene_3d')
      .select('*, buildings(name, code)')
      .eq('project_id', projectId)
      .order('is_active', { ascending: false })
      .order('created_at', { ascending: false });

    if (filters.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active === 'true' || filters.is_active === true);
    }
    if (filters.scene_type) {
      query = query.eq('scene_type', filters.scene_type);
    }
    if (filters.building_id) {
      query = query.eq('building_id', filters.building_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Attach signed URLs for 3D model streaming
    const scenes = await Promise.all((data || []).map(async (scene) => {
      const modelUrl = await this.getSignedReadUrl('3d-models', scene.storage_path);
      return {
        ...scene,
        model_url: modelUrl,
        building_name: scene.buildings?.name,
        building_code: scene.buildings?.code,
        buildings: undefined
      };
    }));

    return scenes;
  }

  /**
   * Find single scene by ID
   */
  static async findById(sceneId) {
    const db = getDB();
    const { data, error } = await db.from('scene_3d')
      .select('*, buildings(name, code), projects(id, name, code, currency)')
      .eq('id', sceneId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;

    const modelUrl = await this.getSignedReadUrl('3d-models', data.storage_path);
    return {
      ...data,
      model_url: modelUrl,
      building_name: data.buildings?.name,
      building_code: data.buildings?.code,
      project_name: data.projects?.name,
      project_code: data.projects?.code,
      project_currency: data.projects?.currency,
      buildings: undefined,
      projects: undefined
    };
  }

  /**
   * Create a new 3D scene
   */
  static async create(projectId, data) {
    const db = getDB();
    const now = new Date().toISOString();

    // Verify project exists
    const { data: project, error: pErr } = await db.from('projects').select('id').eq('id', projectId).single();
    if (pErr || !project) throw new AppError('Проект не найден', 404);

    // If building_id provided, verify it belongs to this project
    if (data.building_id) {
      const { data: bldg } = await db.from('buildings').select('id, project_id').eq('id', data.building_id).single();
      if (!bldg || bldg.project_id !== parseInt(projectId, 10)) {
        throw new AppError('Указанный корпус не принадлежит данному проекту', 400);
      }
    }

    const isActive = data.is_active !== undefined ? data.is_active : true;

    // If marked active, atomically deactivate existing scenes of same scope
    if (isActive) {
      await this.deactivateScope(projectId, data.building_id || null, data.scene_type);
    }

    const { data: newScene, error } = await db.from('scene_3d').insert([{
      project_id: projectId,
      building_id: data.building_id || null,
      name: data.name.trim(),
      scene_type: data.scene_type,
      storage_path: data.storage_path.trim(),
      file_size_bytes: data.file_size_bytes || 0,
      version: data.version || 1,
      is_active: isActive,
      camera_config: data.camera_config || { position: [30, 20, 30], target: [0, 0, 0], fov: 45 },
      environment_config: data.environment_config || { preset: 'city', exposure: 1.0, background_color: '#0f172a' },
      created_at: now,
      updated_at: now
    }]).select().single();

    if (error) throw error;
    return this.findById(newScene.id);
  }

  /**
   * Update scene metadata/config
   */
  static async update(sceneId, data) {
    const db = getDB();
    const now = new Date().toISOString();
    const existing = await this.findById(sceneId);
    if (!existing) throw new AppError('3D сцена не найдена', 404);

    if (data.building_id && data.building_id !== existing.building_id) {
      const { data: bldg } = await db.from('buildings').select('id, project_id').eq('id', data.building_id).single();
      if (!bldg || bldg.project_id !== existing.project_id) {
        throw new AppError('Указанный корпус не принадлежит проекту сцены', 400);
      }
    }

    const updatePayload = {
      ...data,
      updated_at: now
    };

    if (data.is_active === true && !existing.is_active) {
      await this.deactivateScope(existing.project_id, data.building_id || existing.building_id, data.scene_type || existing.scene_type);
    }

    const { data: updated, error } = await db.from('scene_3d')
      .update(updatePayload)
      .eq('id', sceneId)
      .select()
      .single();

    if (error) throw error;
    return this.findById(updated.id);
  }

  /**
   * Atomically activate a scene
   */
  static async activate(sceneId) {
    const scene = await this.findById(sceneId);
    if (!scene) throw new AppError('3D сцена не найдена', 404);

    // Atomically deactivate other scenes of the same project/building/type
    await this.deactivateScope(scene.project_id, scene.building_id, scene.scene_type);

    const now = new Date().toISOString();
    const { error } = await getDB().from('scene_3d')
      .update({ is_active: true, updated_at: now })
      .eq('id', sceneId);

    if (error) throw error;
    return this.findById(sceneId);
  }

  /**
   * Helper to deactivate all scenes matching project + building + type
   */
  static async deactivateScope(projectId, buildingId, sceneType) {
    const db = getDB();
    const now = new Date().toISOString();
    let query = db.from('scene_3d')
      .update({ is_active: false, updated_at: now })
      .eq('project_id', projectId)
      .eq('scene_type', sceneType);

    if (buildingId) {
      query = query.eq('building_id', buildingId);
    } else {
      query = query.is('building_id', null);
    }

    const { error } = await query;
    if (error) throw error;
  }

  /**
   * Delete a 3D scene
   */
  static async delete(sceneId) {
    const db = getDB();
    const existing = await this.findById(sceneId);
    if (!existing) throw new AppError('3D сцена не найдена', 404);

    const { error } = await db.from('scene_3d').delete().eq('id', sceneId);
    if (error) throw error;
    return true;
  }

  /**
   * Validate that an entity exists and belongs to the specified projectId
   */
  static async validateEntityBelongsToProject(projectId, entityType, entityId) {
    const db = getDB();
    const pId = parseInt(projectId, 10);
    const eId = parseInt(entityId, 10);

    if (entityType === 'UNIT') {
      const { data, error } = await db.from('units')
        .select('id, unit_number, rooms, area_m2_x100, price_per_m2_minor, manual_total_price_minor, status, block_reason, floors!inner(floor_number, sections!inner(name, buildings!inner(id, name, project_id)))')
        .eq('id', eId)
        .maybeSingle();

      if (error || !data) throw new AppError(`Квартира с ID ${eId} не найдена`, 404);
      const unitProjectId = data.floors?.sections?.buildings?.project_id;
      if (unitProjectId !== pId) {
        throw new AppError(`Квартира ID ${eId} принадлежит другому проекту (проект #${unitProjectId}), а не проекту сцены #${pId}`, 400);
      }
      return data;
    }

    if (entityType === 'FLOOR') {
      const { data, error } = await db.from('floors')
        .select('id, floor_number, name, sections!inner(buildings!inner(project_id))')
        .eq('id', eId)
        .maybeSingle();

      if (error || !data) throw new AppError(`Этаж с ID ${eId} не найден`, 404);
      const floorProjectId = data.sections?.buildings?.project_id;
      if (floorProjectId !== pId) {
        throw new AppError(`Этаж ID ${eId} принадлежит другому проекту`, 400);
      }
      return data;
    }

    if (entityType === 'SECTION') {
      const { data, error } = await db.from('sections')
        .select('id, name, buildings!inner(project_id)')
        .eq('id', eId)
        .maybeSingle();

      if (error || !data) throw new AppError(`Секция с ID ${eId} не найдена`, 404);
      const sectionProjectId = data.buildings?.project_id;
      if (sectionProjectId !== pId) {
        throw new AppError(`Секция ID ${eId} принадлежит другому проекту`, 400);
      }
      return data;
    }

    if (entityType === 'BUILDING') {
      const { data, error } = await db.from('buildings')
        .select('id, name, code, project_id')
        .eq('id', eId)
        .maybeSingle();

      if (error || !data) throw new AppError(`Корпус с ID ${eId} не найден`, 404);
      if (data.project_id !== pId) {
        throw new AppError(`Корпус ID ${eId} принадлежит другому проекту`, 400);
      }
      return data;
    }

    if (entityType === 'POI') {
      return { id: eId, type: 'POI' };
    }

    throw new AppError(`Неизвестный тип сущности: ${entityType}`, 400);
  }

  /**
   * Get all mapped entities for a scene
   */
  static async getEntities(sceneId) {
    const db = getDB();
    const { data: entities, error } = await db.from('scene_3d_entities')
      .select('*')
      .eq('scene_id', sceneId)
      .order('mesh_key');

    if (error) throw error;

    // Batch resolve UNIT entities with current live CRM data
    const unitIds = (entities || [])
      .filter(e => e.entity_type === 'UNIT')
      .map(e => e.entity_id);

    let unitsMap = {};
    if (unitIds.length > 0) {
      const { data: units } = await db.from('units')
        .select('id, unit_number, rooms, area_m2_x100, price_per_m2_minor, manual_total_price_minor, status, block_reason, floors(floor_number, name, sections(name, buildings(name)))')
        .in('id', unitIds);

      (units || []).forEach(u => {
        unitsMap[u.id] = {
          id: u.id,
          unit_number: u.unit_number,
          rooms: u.rooms,
          area_m2: u.area_m2_x100 / 100,
          price_per_m2_minor: u.price_per_m2_minor,
          total_price_minor: u.manual_total_price_minor || Math.round((u.price_per_m2_minor * u.area_m2_x100) / 100),
          status: u.status,
          block_reason: u.block_reason,
          floor_number: u.floors?.floor_number,
          floor_name: u.floors?.name,
          section_name: u.floors?.sections?.name,
          building_name: u.floors?.sections?.buildings?.name
        };
      });
    }

    return (entities || []).map(e => ({
      ...e,
      unit: e.entity_type === 'UNIT' ? (unitsMap[e.entity_id] || null) : null
    }));
  }

  /**
   * Add a mesh mapping to a scene
   */
  static async createEntity(sceneId, data) {
    const db = getDB();
    const scene = await this.findById(sceneId);
    if (!scene) throw new AppError('3D сцена не найдена', 404);

    // Validate entity belongs to the scene's project
    await this.validateEntityBelongsToProject(scene.project_id, data.entity_type, data.entity_id);

    const now = new Date().toISOString();
    const { data: newEntity, error } = await db.from('scene_3d_entities').insert([{
      scene_id: sceneId,
      mesh_key: data.mesh_key.trim(),
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      interaction_type: data.interaction_type || 'SELECT',
      metadata: data.metadata || {},
      created_at: now,
      updated_at: now
    }]).select().single();

    if (error) {
      if (error.code === '23505') {
        throw new AppError(`Меш с ключом "${data.mesh_key}" уже привязан в этой сцене`, 409);
      }
      throw error;
    }

    return newEntity;
  }

  /**
   * Batch create/replace mesh mappings
   */
  static async batchCreateEntities(sceneId, entities) {
    const scene = await this.findById(sceneId);
    if (!scene) throw new AppError('3D сцена не найдена', 404);

    const results = [];
    for (const item of entities) {
      const created = await this.createEntity(sceneId, item);
      results.push(created);
    }
    return results;
  }

  /**
   * Update entity mapping
   */
  static async updateEntity(entityId, data) {
    const db = getDB();
    const { data: existing, error: findErr } = await db.from('scene_3d_entities')
      .select('*, scene_3d!inner(project_id)')
      .eq('id', entityId)
      .single();

    if (findErr || !existing) throw new AppError('Связь меша не найдена', 404);

    const targetType = data.entity_type || existing.entity_type;
    const targetEntityId = data.entity_id || existing.entity_id;

    if (data.entity_type || data.entity_id) {
      await this.validateEntityBelongsToProject(existing.scene_3d.project_id, targetType, targetEntityId);
    }

    const now = new Date().toISOString();
    const { data: updated, error } = await db.from('scene_3d_entities')
      .update({
        mesh_key: data.mesh_key ? data.mesh_key.trim() : existing.mesh_key,
        entity_type: targetType,
        entity_id: targetEntityId,
        interaction_type: data.interaction_type || existing.interaction_type,
        metadata: data.metadata !== undefined ? data.metadata : existing.metadata,
        updated_at: now
      })
      .eq('id', entityId)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new AppError(`Меш с ключом "${data.mesh_key}" уже привязан в этой сцене`, 409);
      }
      throw error;
    }

    return updated;
  }

  /**
   * Delete entity mapping
   */
  static async deleteEntity(entityId) {
    const db = getDB();
    const { error } = await db.from('scene_3d_entities').delete().eq('id', entityId);
    if (error) throw error;
    return true;
  }

  /**
   * Resolve a mesh_key to real CRM data (used on 3D hover/click)
   */
  static async resolveMesh(sceneId, meshKey) {
    const db = getDB();
    const { data: entity, error } = await db.from('scene_3d_entities')
      .select('*, scene_3d(id, project_id, name)')
      .eq('scene_id', sceneId)
      .eq('mesh_key', meshKey.trim())
      .single();

    if (error || !entity) {
      throw new AppError(`Меш "${meshKey}" не привязан к CRM в этой сцене`, 404);
    }

    const response = {
      sceneId: parseInt(sceneId, 10),
      meshKey: entity.mesh_key,
      entityType: entity.entity_type,
      entityId: entity.entity_id,
      interactionType: entity.interaction_type,
      metadata: entity.metadata
    };

    if (entity.entity_type === 'UNIT') {
      const unit = await this.validateEntityBelongsToProject(entity.scene_3d.project_id, 'UNIT', entity.entity_id);
      response.unit = {
        id: unit.id,
        number: unit.unit_number,
        rooms: unit.rooms,
        area_m2: unit.area_m2_x100 / 100,
        price_per_m2_minor: unit.price_per_m2_minor,
        total_price_minor: unit.manual_total_price_minor || Math.round((unit.price_per_m2_minor * unit.area_m2_x100) / 100),
        status: unit.status,
        block_reason: unit.block_reason,
        floor_number: unit.floors?.floor_number,
        section_name: unit.floors?.sections?.name,
        building_name: unit.floors?.sections?.buildings?.name
      };
    } else if (entity.entity_type === 'BUILDING') {
      const bldg = await this.validateEntityBelongsToProject(entity.scene_3d.project_id, 'BUILDING', entity.entity_id);
      response.building = {
        id: bldg.id,
        name: bldg.name,
        code: bldg.code
      };
    } else if (entity.entity_type === 'FLOOR') {
      const flr = await this.validateEntityBelongsToProject(entity.scene_3d.project_id, 'FLOOR', entity.entity_id);
      response.floor = {
        id: flr.id,
        floor_number: flr.floor_number,
        name: flr.name
      };
    }

    return response;
  }

  /**
   * Generate a secure presigned upload URL for a GLB 3D model
   */
  static async generateUploadUrl(projectId, { sceneType, filename, fileSizeBytes, sceneId }) {
    const db = getDB();
    const pId = parseInt(projectId, 10);

    // Verify project exists
    const { data: project } = await db.from('projects').select('id').eq('id', pId).single();
    if (!project) throw new AppError('Проект не найден', 404);

    // Sanitize filename to prevent directory traversal
    const cleanFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const sId = sceneId || 'new';
    const storagePath = `projects/${pId}/3d/${sId}/${timestamp}_${cleanFilename}`;

    try {
      const { data, error } = await db.storage.from('3d-models').createSignedUploadUrl(storagePath);
      if (error) {
        // If createSignedUploadUrl is not supported on anon key or bucket, return deterministic path
        return {
          bucket: '3d-models',
          storagePath,
          storage_path: storagePath,
          signedUrl: null,
          signedUploadUrl: null,
          uploadUrl: null
        };
      }

      return {
        bucket: '3d-models',
        storagePath,
        storage_path: storagePath,
        signedUrl: data?.signedUrl,
        signedUploadUrl: data?.signedUrl,
        uploadUrl: data?.signedUrl,
        token: data?.token
      };
    } catch (e) {
      return {
        bucket: '3d-models',
        storagePath,
        storage_path: storagePath,
        signedUrl: null,
        signedUploadUrl: null,
        uploadUrl: null
      };
    }
  }
}
