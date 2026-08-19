import { getDB } from '../../db/connection.js';

export class LeadsRepository {
  static async findAll(filters = {}) {
    const db = getDB();
    let query = db.from('leads').select('*, users!responsible_user_id(name), projects!interested_project_id(name), lead_notes(id), deals(id)').is('archived_at', null).order('created_at', { ascending: false });

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.projectId) query = query.eq('interested_project_id', filters.projectId);
    if (filters.responsibleUserId) query = query.eq('responsible_user_id', filters.responsibleUserId);

    const { data, error } = await query;
    if (error) throw error;

    let leads = data || [];
    if (filters.search) {
      const s = filters.search.toLowerCase();
      leads = leads.filter(l => 
        (l.full_name && l.full_name.toLowerCase().includes(s)) ||
        (l.phone && l.phone.toLowerCase().includes(s)) ||
        (l.passport_number && l.passport_number.toLowerCase().includes(s))
      );
    }

    return leads.map(l => ({
      ...l,
      responsible_user_name: l.users?.name,
      interested_project_name: l.projects?.name,
      notes_count: l.lead_notes?.length || 0,
      deals_count: l.deals?.length || 0,
      users: undefined, projects: undefined, lead_notes: undefined, deals: undefined
    }));
  }

  static async findById(id) {
    const db = getDB();
    const { data: lead, error } = await db.from('leads').select('*, users!responsible_user_id(name), projects!interested_project_id(name), lead_notes(*, users!author_user_id(name)), deals(*, units(unit_number, floors(sections(buildings(projects(name))))))').eq('id', id).is('archived_at', null).single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!lead) return null;

    const notes_list = (lead.lead_notes || []).map(n => ({
      ...n, author_name: n.users?.name, users: undefined
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const deals_list = (lead.deals || []).map(d => ({
      ...d,
      unit_number: d.units?.unit_number,
      project_name: d.units?.floors?.sections?.buildings?.projects?.name,
      units: undefined
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return {
      ...lead,
      responsible_user_name: lead.users?.name,
      interested_project_name: lead.projects?.name,
      notes_list,
      deals_list,
      users: undefined, projects: undefined, lead_notes: undefined, deals: undefined
    };
  }

  static async create(data) {
    const db = getDB();
    const now = new Date().toISOString();
    const { data: lead, error } = await db.from('leads').insert([{
      ...data,
      source: data.source || 'DIRECT',
      status: data.status || 'NEW',
      desired_rooms: data.desired_rooms ? parseInt(data.desired_rooms, 10) : null,
      created_at: now,
      updated_at: now
    }]).select().single();
    if (error) throw error;
    return this.findById(lead.id);
  }

  static async update(id, data) {
    const db = getDB();
    const now = new Date().toISOString();
    await db.from('leads').update({
      ...data,
      desired_rooms: data.desired_rooms ? parseInt(data.desired_rooms, 10) : null,
      updated_at: now
    }).eq('id', id);
    return this.findById(id);
  }

  static async updateStatus(id, status, lostReason = null) {
    const db = getDB();
    const now = new Date().toISOString();
    await db.from('leads').update({ status, lost_reason: lostReason, updated_at: now }).eq('id', id);
    return this.findById(id);
  }

  static async addNote(leadId, authorUserId, body) {
    const db = getDB();
    const now = new Date().toISOString();
    const { data: note } = await db.from('lead_notes').insert([{ lead_id: leadId, author_user_id: authorUserId, body, created_at: now }]).select('*, users!author_user_id(name)').single();
    return { ...note, author_name: note.users?.name, users: undefined };
  }

  static async archive(id) {
    const db = getDB();
    const now = new Date().toISOString();
    await db.from('leads').update({ archived_at: now }).eq('id', id);
  }
}
