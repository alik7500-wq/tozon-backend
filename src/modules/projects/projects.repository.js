import { getDB } from '../../db/connection.js';

export class ProjectsRepository {
  static async findAll() {
    const db = getDB();
    const { data, error } = await db
      .from('projects')
      .select('*')
      .is('archived_at', null)
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    return data || [];
  }

  static async findById(id) {
    const db = getDB();
    const { data, error } = await db
      .from('projects')
      .select('*')
      .eq('id', id)
      .is('archived_at', null)
      .single();
      
    if (error && error.code !== 'PGRST116') throw error; // PGRST116 means 0 rows
    return data;
  }

  static async findByCode(code) {
    const db = getDB();
    const { data, error } = await db
      .from('projects')
      .select('*')
      .eq('code', code)
      .is('archived_at', null)
      .single();
      
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  static async create(project) {
    const db = getDB();
    const now = new Date().toISOString();
    
    const { data, error } = await db
      .from('projects')
      .insert([{
        ...project,
        description: project.description || null,
        currency: project.currency || 'TJS',
        created_at: now,
        updated_at: now,
      }])
      .select()
      .single();
      
    if (error) throw error;
    return data;
  }
}
