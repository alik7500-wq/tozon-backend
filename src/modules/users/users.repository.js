import { getDB } from '../../db/connection.js';

export class UsersRepository {
  static async findAll() {
    const db = getDB();
    const { data, error } = await db
      .from('users')
      .select('id, name, email, role, permissions, is_active, created_at, updated_at')
      .order('id', { ascending: true });
      
    if (error) throw error;
    return data || [];
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
    const { data, error } = await db
      .from('users')
      .select('id, name, email, role, permissions, is_active, created_at, updated_at')
      .eq('id', id)
      .single();
      
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  static async create(user) {
    const db = getDB();
    const now = new Date().toISOString();
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
      
    if (error) throw error;
    return this.findById(data.id);
  }

  static async update(id, updates) {
    const db = getDB();
    const now = new Date().toISOString();
    const payload = { ...updates, updated_at: now };
    if (payload.email) payload.email = payload.email.toLowerCase();

    const { data, error } = await db
      .from('users')
      .update(payload)
      .eq('id', id)
      .select('id, name, email, role, permissions, is_active, created_at, updated_at')
      .single();

    if (error) throw error;
    return data;
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
