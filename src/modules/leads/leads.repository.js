import { getDB } from '../../db/connection.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';

export class LeadsRepository {
  static async findAll(filters = {}) {
    const db = getDB();
    let query = db.from('leads').select('*, users!responsible_user_id(name), projects!interested_project_id(name), lead_notes(id), deals(id)').is('archived_at', null).order('created_at', { ascending: false });

    if (filters.status && filters.status !== 'ALL') query = query.eq('status', filters.status);
    const cleanProjectId = parseOptionalBigInt(filters.projectId);
    if (cleanProjectId) query = query.eq('interested_project_id', cleanProjectId);
    const cleanUserId = parseOptionalBigInt(filters.responsibleUserId);
    if (cleanUserId) query = query.eq('responsible_user_id', cleanUserId);

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
    const cleanId = parseRequiredBigInt(id, 'id');
    const db = getDB();
    const { data: lead, error } = await db
      .from('leads')
      .select('*, users!responsible_user_id(name), projects!interested_project_id(name), lead_notes(*), deals(*)')
      .eq('id', cleanId)
      .is('archived_at', null)
      .maybeSingle();

    if (error) throw error;
    if (!lead) return null;

    const notes_list = (lead.lead_notes || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const deals_list = (lead.deals || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return {
      ...lead,
      responsible_user_name: lead.users?.name || 'Admin',
      interested_project_name: lead.projects?.name || null,
      notes_list,
      deals_list,
      users: undefined,
      projects: undefined,
      lead_notes: undefined,
      deals: undefined
    };
  }

  static _prepareLeadData(data) {
    const payload = {};
    
    if (data.full_name !== undefined) payload.full_name = data.full_name ? String(data.full_name).trim() : '';
    if (data.phone !== undefined) payload.phone = data.phone ? String(data.phone).trim() : '';
    if (data.secondary_phone !== undefined) payload.secondary_phone = data.secondary_phone ? String(data.secondary_phone).trim() : null;
    if (data.source !== undefined) payload.source = data.source || 'DIRECT';
    if (data.status !== undefined) payload.status = data.status || 'NEW';
    
    if (data.responsible_user_id !== undefined) {
      payload.responsible_user_id = parseOptionalBigInt(data.responsible_user_id);
    }
    if (data.interested_project_id !== undefined) {
      payload.interested_project_id = parseOptionalBigInt(data.interested_project_id);
    }
    if (data.desired_rooms !== undefined) {
      const r = Number(data.desired_rooms);
      payload.desired_rooms = Number.isInteger(r) && r > 0 ? r : null;
    }
    if (data.budget_min_minor !== undefined) {
      const bMin = Number(data.budget_min_minor);
      payload.budget_min_minor = Number.isFinite(bMin) && bMin >= 0 ? Math.round(bMin) : null;
    }
    if (data.budget_max_minor !== undefined) {
      const bMax = Number(data.budget_max_minor);
      payload.budget_max_minor = Number.isFinite(bMax) && bMax >= 0 ? Math.round(bMax) : null;
    } else if (data.budget_max) {
      const bMaxNum = parseFloat(data.budget_max);
      payload.budget_max_minor = Number.isFinite(bMaxNum) ? Math.round(bMaxNum * 100) : null;
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
