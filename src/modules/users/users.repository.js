import { getDB } from '../../db/connection.js';

export class UsersRepository {
  static async findAll() {
    const db = getDB();
    try {
      const { data, error } = await db
        .from('users')
        .select('id, name, email, role, permissions, is_active, is_sales_rep, created_at, updated_at')
        .order('id', { ascending: true });
      if (!error && data) return data;
    } catch {
      // Fallback if is_sales_rep column does not exist yet
    }

    const { data: fbData, error: fbErr } = await db
      .from('users')
      .select('id, name, email, role, permissions, is_active, created_at, updated_at')
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
    try {
      const { data, error } = await db
        .from('users')
        .select('id, name, email, role, permissions, is_active, is_sales_rep, created_at, updated_at')
        .eq('id', id)
        .single();
      if (!error && data) return data;
    } catch {
      // Fallback
    }

    const { data: fbData, error: fbErr } = await db
      .from('users')
      .select('id, name, email, role, permissions, is_active, created_at, updated_at')
      .eq('id', id)
      .single();
      
    if (fbErr && fbErr.code !== 'PGRST116') throw fbErr;
    return fbData;
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
}
