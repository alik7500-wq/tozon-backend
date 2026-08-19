import { getDB } from '../../db/connection.js';

export class UsersRepository {
  static async findByEmail(email) {
    const db = getDB();
    const { data, error } = await db
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
      
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  static async findById(id) {
    const db = getDB();
    const { data, error } = await db
      .from('users')
      .select('id, name, email, role, is_active, created_at, updated_at')
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
        created_at: now,
        updated_at: now,
      }])
      .select()
      .single();
      
    if (error) throw error;
    return this.findById(data.id);
  }
}
