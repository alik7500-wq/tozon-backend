import { getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class LayoutPresentationRepository {
  /**
   * Check if user has access to a project ID based on role
   */
  static validateUserProjectAccess(user, projectId) {
    if (!user) {
      throw new AppError('Пользователь не авторизован', 401);
    }
    // ADMIN and DIRECTOR have global access to all projects
    if (['ADMIN', 'DIRECTOR'].includes(user.role)) {
      return true;
    }
    // If user has specific assigned project IDs
    if (user.assigned_project_ids && Array.isArray(user.assigned_project_ids)) {
      if (!user.assigned_project_ids.map(Number).includes(Number(projectId))) {
        throw new AppError('Доступ к объекту недвижимости запрещен', 403);
      }
    }
    return true;
  }

  /**
   * Aggregated data for apartment unit interactive presentation
   */
  static async getUnitPresentationData(unitId, user = null) {
    const db = getDB();

    // 1. Fetch unit details
    const { data: unit, error: unitError } = await db
      .from('units')
      .select(`
        *,
        floors (
          id,
          floor_number,
          name,
          sections (
            id,
            name,
            code,
            buildings (
              id,
              project_id,
              name,
              code,
              projects (
                id,
                name,
                address
              )
            )
          )
        ),
        layout_types (*)
      `)
      .eq('id', unitId)
      .maybeSingle();

    if (unitError) {
      console.error('Error fetching unit presentation:', unitError);
      throw new AppError('Ошибка получения данных квартиры', 500);
    }

    if (!unit) {
      throw new AppError('Квартира не найдена', 404);
    }

    const projectId = unit.floors?.sections?.buildings?.project_id || unit.floors?.sections?.buildings?.projects?.id;
    if (user && projectId) {
      this.validateUserProjectAccess(user, projectId);
    }

    let layout = unit.layout_types || null;
    let rooms = [];
    let features = [];

    // 2. Fetch layout presentation details if layout exists
    if (layout?.id) {
      const [{ data: roomsData }, { data: featuresData }] = await Promise.all([
        db
          .from('layout_rooms')
          .select('*')
          .eq('layout_type_id', layout.id)
          .eq('is_active', true)
          .order('sort_order', { ascending: true })
          .order('room_number', { ascending: true }),
        db
          .from('layout_features')
          .select('*')
          .eq('layout_type_id', layout.id)
          .eq('is_active', true)
          .order('sort_order', { ascending: true }),
      ]);

      rooms = roomsData || [];
      features = featuresData || [];
    }

    // 3. Fetch optional 3D Scene mapping for unit / building
    const buildingId = unit.floors?.sections?.buildings?.id;

    let scene3d = null;
    if (projectId) {
      const { data: scenes } = await db
        .from('scene_3d')
        .select('*, scene_3d_entities(*)')
        .eq('project_id', projectId)
        .eq('is_active', true);

      if (scenes && scenes.length > 0) {
        scene3d = scenes.find((s) =>
          s.scene_3d_entities?.some((e) => e.entity_type === 'UNIT' && String(e.entity_id) === String(unitId))
        ) || scenes[0];
      }
    }

    // 4. Fetch optional 360° Tour mapping for unit / building
    let tour360 = null;
    if (projectId) {
      const { data: tours } = await db
        .from('tours_360')
        .select('*, panorama_360(*)')
        .eq('project_id', projectId)
        .eq('is_active', true);

      if (tours && tours.length > 0) {
        tour360 = tours.find(
          (t) => (t.entity_type === 'UNIT' && String(t.entity_id) === String(unitId))
        ) || tours.find(
          (t) => (t.entity_type === 'BUILDING' && String(t.entity_id) === String(buildingId))
        ) || tours[0];
      }
    }

    return {
      unit,
      layout,
      rooms,
      features,
      scene3d,
      tour360,
    };
  }

  /**
   * Fetch full layout presentation config for admin editor
   */
  static async getLayoutPresentationData(layoutId, user = null) {
    const db = getDB();

    const { data: layout, error } = await db
      .from('layout_types')
      .select('*')
      .eq('id', layoutId)
      .maybeSingle();

    if (error || !layout) {
      throw new AppError('Типовая планировка не найдена', 404);
    }

    if (user && layout.project_id) {
      this.validateUserProjectAccess(user, layout.project_id);
    }

    const [{ data: rooms }, { data: features }] = await Promise.all([
      db
        .from('layout_rooms')
        .select('*')
        .eq('layout_type_id', layoutId)
        .order('sort_order', { ascending: true })
        .order('room_number', { ascending: true }),
      db
        .from('layout_features')
        .select('*')
        .eq('layout_type_id', layoutId)
        .order('sort_order', { ascending: true }),
    ]);

    return {
      layout,
      rooms: rooms || [],
      features: features || [],
    };
  }

  /**
   * Update extended fields of a layout type
   */
  static async updateLayoutExtended(layoutId, payload, user = null) {
    const db = getDB();

    // Verify layout existence and project access
    const { data: existingLayout } = await db
      .from('layout_types')
      .select('id, project_id')
      .eq('id', layoutId)
      .maybeSingle();

    if (!existingLayout) {
      throw new AppError('Планировка не найдена', 404);
    }

    if (user) {
      this.validateUserProjectAccess(user, existingLayout.project_id);
    }

    const now = new Date().toISOString();
    const allowedFields = [
      'name',
      'name_tg',
      'code',
      'rooms',
      'area_m2_x100',
      'default_price_per_m2_minor',
      'description',
      'description_ru',
      'description_tg',
      'furnished_plan_path',
      'technical_plan_path',
      'living_area',
      'kitchen_area',
      'ceiling_height',
      'bathrooms_count',
      'windows_count',
      'doors_count',
      'balconies_count',
      'heating_type_ru',
      'heating_type_tg',
      'ventilation_type_ru',
      'ventilation_type_tg',
      'orientation_ru',
      'orientation_tg',
      'is_published',
    ];

    const updates = { updated_at: now };
    for (const key of allowedFields) {
      if (payload[key] !== undefined) {
        updates[key] = payload[key];
      }
    }

    const { data, error } = await db
      .from('layout_types')
      .update(updates)
      .eq('id', layoutId)
      .select()
      .single();

    if (error) {
      console.error('Error updating layout extended:', error);
      throw new AppError('Ошибка обновления характеристик планировки', 500);
    }

    return data;
  }

  /**
   * Room CRUD operations with BOLA / IDOR protection
   */
  static async createRoom(layoutId, roomData, user = null) {
    const area = Number(roomData.area);
    if (!Number.isFinite(area) || area <= 0) {
      throw new AppError('Площадь комнаты должна быть больше нуля', 400);
    }

    const posX = Number(roomData.position_x_percent ?? 50);
    const posY = Number(roomData.position_y_percent ?? 50);
    if (posX < 0 || posX > 100 || posY < 0 || posY > 100) {
      throw new AppError('Координаты метки должны быть в пределе от 0 до 100%', 400);
    }

    const db = getDB();

    // Verify layout existence
    const { data: layout } = await db
      .from('layout_types')
      .select('id, project_id')
      .eq('id', layoutId)
      .maybeSingle();

    if (!layout) {
      throw new AppError('Планировка не найдена', 404);
    }

    if (user) {
      this.validateUserProjectAccess(user, layout.project_id);
    }

    const now = new Date().toISOString();

    const newRoom = {
      layout_type_id: Number(layoutId),
      room_number: Number(roomData.room_number || 1),
      room_type: roomData.room_type || 'ROOM',
      name_ru: roomData.name_ru || `Комната ${roomData.room_number || 1}`,
      name_tg: roomData.name_tg || null,
      area,
      description_ru: roomData.description_ru || null,
      description_tg: roomData.description_tg || null,
      floor_finish_ru: roomData.floor_finish_ru || null,
      floor_finish_tg: roomData.floor_finish_tg || null,
      wall_finish_ru: roomData.wall_finish_ru || null,
      wall_finish_tg: roomData.wall_finish_tg || null,
      ceiling_finish_ru: roomData.ceiling_finish_ru || null,
      ceiling_finish_tg: roomData.ceiling_finish_tg || null,
      lighting_ru: roomData.lighting_ru || null,
      lighting_tg: roomData.lighting_tg || null,
      ventilation_ru: roomData.ventilation_ru || null,
      ventilation_tg: roomData.ventilation_tg || null,
      position_x_percent: posX,
      position_y_percent: posY,
      polygon_points: roomData.polygon_points || null,
      sort_order: Number(roomData.sort_order || 0),
      is_active: roomData.is_active !== false,
      created_at: now,
      updated_at: now,
    };

    const { data, error } = await db
      .from('layout_rooms')
      .insert([newRoom])
      .select()
      .single();

    if (error) {
      console.error('Error creating room:', error);
      if (error.code === '23505') {
        throw new AppError(`Комната с номером ${roomData.room_number} уже существует в этой планировке`, 400);
      }
      throw new AppError('Ошибка сохранения комнаты', 500);
    }

    return data;
  }

  static async updateRoom(layoutId, roomId, roomData, user = null) {
    const db = getDB();

    // Fetch existing room and check parent layout
    const { data: existingRoom } = await db
      .from('layout_rooms')
      .select('*, layout_types!inner(id, project_id)')
      .eq('id', roomId)
      .maybeSingle();

    if (!existingRoom) {
      throw new AppError('Комната не найдена', 404);
    }

    if (Number(existingRoom.layout_type_id) !== Number(layoutId)) {
      throw new AppError('Комната не принадлежит указанной планировке', 400);
    }

    if (user) {
      this.validateUserProjectAccess(user, existingRoom.layout_types?.project_id);
    }

    // Strict IDOR protection: Prevent changing layout_type_id to another project's layout
    if (roomData.layout_type_id !== undefined && Number(roomData.layout_type_id) !== Number(layoutId)) {
      const { data: targetLayout } = await db
        .from('layout_types')
        .select('project_id')
        .eq('id', roomData.layout_type_id)
        .maybeSingle();

      if (!targetLayout || Number(targetLayout.project_id) !== Number(existingRoom.layout_types?.project_id)) {
        throw new AppError('Перенос комнаты в чужой проект запрещен', 403);
      }
    }

    const now = new Date().toISOString();
    const updates = { updated_at: now };
    const allowed = [
      'room_number',
      'room_type',
      'name_ru',
      'name_tg',
      'area',
      'description_ru',
      'description_tg',
      'floor_finish_ru',
      'floor_finish_tg',
      'wall_finish_ru',
      'wall_finish_tg',
      'ceiling_finish_ru',
      'ceiling_finish_tg',
      'lighting_ru',
      'lighting_tg',
      'ventilation_ru',
      'ventilation_tg',
      'position_x_percent',
      'position_y_percent',
      'polygon_points',
      'sort_order',
      'is_active',
    ];

    for (const key of allowed) {
      if (roomData[key] !== undefined) {
        updates[key] = roomData[key];
      }
    }

    if (updates.area !== undefined) {
      const area = Number(updates.area);
      if (!Number.isFinite(area) || area <= 0) {
        throw new AppError('Площадь комнаты должна быть больше нуля', 400);
      }
      updates.area = area;
    }

    if (updates.position_x_percent !== undefined) {
      const posX = Number(updates.position_x_percent);
      if (posX < 0 || posX > 100) throw new AppError('Координата X должна быть в пределах 0-100%', 400);
      updates.position_x_percent = posX;
    }

    if (updates.position_y_percent !== undefined) {
      const posY = Number(updates.position_y_percent);
      if (posY < 0 || posY > 100) throw new AppError('Координата Y должна быть в пределах 0-100%', 400);
      updates.position_y_percent = posY;
    }

    const { data, error } = await db
      .from('layout_rooms')
      .update(updates)
      .eq('id', roomId)
      .select()
      .single();

    if (error) {
      console.error('Error updating room:', error);
      throw new AppError('Ошибка обновления данных комнаты', 500);
    }

    return data;
  }

  static async deleteRoom(layoutId, roomId, user = null) {
    const db = getDB();

    const { data: room } = await db
      .from('layout_rooms')
      .select('id, layout_type_id, layout_types!inner(project_id)')
      .eq('id', roomId)
      .maybeSingle();

    if (!room) {
      throw new AppError('Комната не найдена', 404);
    }

    if (Number(room.layout_type_id) !== Number(layoutId)) {
      throw new AppError('Комната не принадлежит указанной планировке', 400);
    }

    if (user) {
      this.validateUserProjectAccess(user, room.layout_types?.project_id);
    }

    const { error } = await db.from('layout_rooms').delete().eq('id', roomId);
    if (error) {
      console.error('Error deleting room:', error);
      throw new AppError('Ошибка удаления комнаты', 500);
    }
  }

  /**
   * Feature CRUD operations with BOLA protection
   */
  static async createFeature(layoutId, featureData, user = null) {
    if (!featureData.text_ru || !featureData.text_ru.trim()) {
      throw new AppError('Русское наименование преимущества обязательно', 400);
    }

    const db = getDB();

    const { data: layout } = await db
      .from('layout_types')
      .select('id, project_id')
      .eq('id', layoutId)
      .maybeSingle();

    if (!layout) throw new AppError('Планировка не найдена', 404);

    if (user) this.validateUserProjectAccess(user, layout.project_id);

    const now = new Date().toISOString();

    const newFeature = {
      layout_type_id: Number(layoutId),
      icon_key: featureData.icon_key || 'Sparkles',
      text_ru: featureData.text_ru.trim(),
      text_tg: featureData.text_tg ? featureData.text_tg.trim() : null,
      sort_order: Number(featureData.sort_order || 0),
      is_active: featureData.is_active !== false,
      created_at: now,
      updated_at: now,
    };

    const { data, error } = await db
      .from('layout_features')
      .insert([newFeature])
      .select()
      .single();

    if (error) {
      console.error('Error creating feature:', error);
      throw new AppError('Ошибка добавления преимущества', 500);
    }

    return data;
  }

  static async updateFeature(layoutId, featureId, featureData, user = null) {
    const db = getDB();

    const { data: feature } = await db
      .from('layout_features')
      .select('*, layout_types!inner(project_id)')
      .eq('id', featureId)
      .maybeSingle();

    if (!feature) throw new AppError('Преимущество не найдено', 404);

    if (Number(feature.layout_type_id) !== Number(layoutId)) {
      throw new AppError('Преимущество не принадлежит указанной планировке', 400);
    }

    if (user) this.validateUserProjectAccess(user, feature.layout_types?.project_id);

    const now = new Date().toISOString();
    const updates = { updated_at: now };
    const allowed = ['icon_key', 'text_ru', 'text_tg', 'sort_order', 'is_active'];
    for (const key of allowed) {
      if (featureData[key] !== undefined) {
        updates[key] = featureData[key];
      }
    }

    const { data, error } = await db
      .from('layout_features')
      .update(updates)
      .eq('id', featureId)
      .select()
      .single();

    if (error) {
      console.error('Error updating feature:', error);
      throw new AppError('Ошибка обновления преимущества', 500);
    }

    return data;
  }

  static async deleteFeature(layoutId, featureId, user = null) {
    const db = getDB();

    const { data: feature } = await db
      .from('layout_features')
      .select('id, layout_type_id, layout_types!inner(project_id)')
      .eq('id', featureId)
      .maybeSingle();

    if (!feature) throw new AppError('Преимущество не найдено', 404);

    if (Number(feature.layout_type_id) !== Number(layoutId)) {
      throw new AppError('Преимущество не принадлежит указанной планировке', 400);
    }

    if (user) this.validateUserProjectAccess(user, feature.layout_types?.project_id);

    const { error } = await db.from('layout_features').delete().eq('id', featureId);
    if (error) {
      console.error('Error deleting feature:', error);
      throw new AppError('Ошибка удаления преимущества', 500);
    }
  }
}
