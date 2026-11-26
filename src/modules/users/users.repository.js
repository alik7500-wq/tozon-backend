import { getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const BASE_USER_COLS = 'id, name, email, role, permissions, is_active, created_at, updated_at';
const EXT_USER_COLS = 'id, name, email, role, permissions, is_active, is_sales_rep, all_projects_access, created_at, updated_at';

async function attachUserProjectScope(db, user) {
  if (!user) return null;
  const { data: projectRows, error: projectErr } = await db
    .from('user_project_access')
    .select('project_id')
    .eq('user_id', user.id)
    .eq('can_view', true);

  if (projectErr) {
    throw new AppError('Не удалось загрузить проектные права доступа пользователя', 503);
  }

  const allowedIds = (projectRows || []).map((row) => String(row.project_id));
  return {
    ...user,
    all_projects_access: Boolean(user.all_projects_access),
    allowed_project_ids: allowedIds,
    assigned_project_ids: allowedIds.map(Number)
  };
}

export class UsersRepository {
  static async findAll() {
    const db = getDB();
    try {
      const { data, error } = await db
        .from('users')
        .select(EXT_USER_COLS)
        .order('id', { ascending: true });
      if (!error && data) return data;
    } catch {
      // Fallback if extended columns do not exist yet
    }

    const { data: fbData, error: fbErr } = await db
      .from('users')
      .select(BASE_USER_COLS)
      .order('id', { ascending: true });
      
    if (fbErr) throw fbErr;
    return fbData || [];
  }

  static async findByEmail(email) {
    const db = getDB();
    const { data, error } = await db
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();
      
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  static async findById(id) {
    const db = getDB();
    let userRow = null;
    try {
      const { data, error } = await db
        .from('users')
        .select(EXT_USER_COLS)
        .eq('id', id)
        .single();
      if (!error && data) userRow = data;
    } catch {
      // Fallback if extended columns do not exist yet
    }

    if (!userRow) {
      const { data: fbData, error: fbErr } = await db
        .from('users')
        .select(BASE_USER_COLS)
        .eq('id', id)
        .single();
        
      if (fbErr && fbErr.code !== 'PGRST116') throw fbErr;
      userRow = fbData;
    }

    return attachUserProjectScope(db, userRow);
  }

  static async create(user) {
    const db = getDB();
    const now = new Date().toISOString();
    try {
      const { data, error } = await db
        .from('users')
        .insert([{
          ...user,
          email: user.email.toLowerCase(),
          created_at: now,
          updated_at: now,
        }])
        .select()
        .single();
      if (!error && data) return this.findById(data.id);
    } catch {
      // If error (e.g. column is_sales_rep does not exist yet), insert without is_sales_rep
    }

    const payload = { ...user };
    delete payload.is_sales_rep;
    const { data: fbData, error: fbErr } = await db
      .from('users')
      .insert([{
        ...payload,
        email: user.email.toLowerCase(),
        created_at: now,
        updated_at: now,
      }])
      .select()
      .single();

    if (fbErr) throw fbErr;
    return this.findById(fbData.id);
  }

  static async update(id, updates) {
    const db = getDB();
    const now = new Date().toISOString();
    const payload = { ...updates, updated_at: now };
    if (payload.email) payload.email = payload.email.toLowerCase();

    try {
      const { data, error } = await db
        .from('users')
        .update(payload)
        .eq('id', id)
        .select('id, name, email, role, permissions, is_active, is_sales_rep, created_at, updated_at')
        .single();
      if (!error && data) return data;
    } catch {
      // Fallback if column is_sales_rep does not exist yet
    }

    const safePayload = { ...payload };
    delete safePayload.is_sales_rep;
    const { data: fbData, error: fbErr } = await db
      .from('users')
      .update(safePayload)
      .eq('id', id)
      .select('id, name, email, role, permissions, is_active, created_at, updated_at')
      .single();

    if (fbErr) throw fbErr;
    return fbData;
  }

  static async delete(id) {
    const db = getDB();
    const { error } = await db
      .from('users')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return true;
  }

  static async setProjectAccess(userId, { allProjectsAccess, projectIds, actorId = null }) {
    if (!/^\d+$/.test(String(userId || '')) || Number(userId) <= 0) {
      throw new AppError('Некорректный ID пользователя', 400);
    }
    if (typeof allProjectsAccess !== 'boolean') {
      throw new AppError('all_projects_access должен быть boolean', 400);
    }
    if (!Array.isArray(projectIds)) {
      throw new AppError('allowed_project_ids должен быть массивом', 400);
    }
    const normalizedIds = [];
    for (const rawId of projectIds) {
      const strId = String(rawId ?? '').trim();
      if (!/^\d+$/.test(strId) || Number(strId) <= 0 || !Number.isSafeInteger(Number(strId))) {
        throw new AppError(`Некорректный ID проекта: ${rawId}`, 400);
      }
      normalizedIds.push(Number(strId));
    }

    const db = getDB();
    const { data: rpcRes, error: rpcErr } = await db.rpc('fn_set_user_project_access', {
      p_user_id: Number(userId),
      p_all_projects_access: allProjectsAccess,
      p_project_ids: normalizedIds,
      p_actor_id: actorId ? Number(actorId) : null
    });
    if (rpcErr) {
      throw new AppError('Не удалось транзакционно обновить проектные права', 503);
    }
    if (rpcRes?.ok === false) {
      const status = rpcRes.code === 'USER_NOT_FOUND' ? 404 : 400;
      throw new AppError(rpcRes.message || 'Ошибка назначения проектных прав', status);
    }

    return this.findById(userId);
  }
}
