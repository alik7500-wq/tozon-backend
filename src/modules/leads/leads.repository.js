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
  static _prepareLeadData(data) {
    const payload = {};
    
    if (data.full_name !== undefined) payload.full_name = data.full_name ? String(data.full_name).trim() : '';
    if (data.phone !== undefined) payload.phone = data.phone ? String(data.phone).trim() : '';
    if (data.secondary_phone !== undefined) payload.secondary_phone = data.secondary_phone ? String(data.secondary_phone).trim() : null;
    if (data.source !== undefined) payload.source = data.source || 'DIRECT';
    if (data.status !== undefined) payload.status = data.status || 'NEW';
    
    if (data.responsible_user_id !== undefined) {
      payload.responsible_user_id = data.responsible_user_id ? parseInt(data.responsible_user_id, 10) : null;
    }
    if (data.interested_project_id !== undefined) {
      payload.interested_project_id = data.interested_project_id ? parseInt(data.interested_project_id, 10) : null;
    }
    if (data.desired_rooms !== undefined) {
      payload.desired_rooms = data.desired_rooms !== '' && data.desired_rooms !== null ? parseInt(data.desired_rooms, 10) : null;
    }
    if (data.budget_min_minor !== undefined) {
      payload.budget_min_minor = data.budget_min_minor !== '' && data.budget_min_minor !== null ? parseInt(data.budget_min_minor, 10) : null;
    }
    if (data.budget_max_minor !== undefined) {
      payload.budget_max_minor = data.budget_max_minor !== '' && data.budget_max_minor !== null ? parseInt(data.budget_max_minor, 10) : null;
    } else if (data.budget_max) {
      payload.budget_max_minor = Math.round(parseFloat(data.budget_max) * 100);
    }
    
    if (data.passport_series !== undefined) payload.passport_series = data.passport_series || null;
    if (data.passport_number !== undefined) payload.passport_number = data.passport_number || null;
    if (data.passport_issued_by !== undefined) payload.passport_issued_by = data.passport_issued_by || null;
    if (data.passport_issue_date !== undefined) payload.passport_issue_date = data.passport_issue_date || null;
    if (data.birth_date !== undefined) payload.birth_date = data.birth_date || null;
    if (data.registration_address !== undefined) payload.registration_address = data.registration_address || null;
    if (data.notes !== undefined) payload.notes = data.notes || null;
    if (data.lost_reason !== undefined) payload.lost_reason = data.lost_reason || null;

    return payload;
  }

  static async create(data) {
    const db = getDB();
    const now = new Date().toISOString();
    const prepared = this._prepareLeadData(data);
    prepared.created_at = now;
    prepared.updated_at = now;

    const { data: lead, error } = await db.from('leads').insert([prepared]).select().single();
    if (error) throw error;
    return this.findById(lead.id);
  }

  static async update(id, data) {
    const db = getDB();
    const now = new Date().toISOString();
    const prepared = this._prepareLeadData(data);
    prepared.updated_at = now;

    const { error } = await db.from('leads').update(prepared).eq('id', id);
    if (error) throw error;
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
