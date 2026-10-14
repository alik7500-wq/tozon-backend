import { getDB, getServiceDB } from '../../db/connection.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';
import { matchSearchQuery } from '../../utils/searchUtils.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { calculateWorkingMinutes, formatWorkingDuration, getBusinessDate } from '../../utils/businessTime.js';

const getHistoryDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

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
      leads = leads.filter(l => 
        matchSearchQuery(l, ['full_name', 'phone', 'passport_series', 'passport_number', 'inn', 'registration_address'], filters.search, {
          phoneFields: ['phone'],
          innFields: ['inn']
        })
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
    const status_history = await this.getStatusHistory(cleanId);

    return {
      ...lead,
      responsible_user_name: lead.users?.name || 'Admin',
      interested_project_name: lead.projects?.name || null,
      notes_list,
      deals_list,
      status_history,
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
    if (data.inn !== undefined) payload.inn = data.inn ? String(data.inn).trim() : null;
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

    // Trigger internal notification for new lead
    NotificationsService.notifyLeadCreated(lead).catch(err => {
      console.warn('Failed to dispatch LEAD_CREATED notification:', err);
    });

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

  static async updateStatus(id, status, lostReason = null, comment = null, changedByUserId = null) {
    const cleanId = parseRequiredBigInt(id, 'id');
    const db = getDB();
    const now = new Date().toISOString();

    const { data: currentLead } = await db.from('leads').select('status').eq('id', cleanId).maybeSingle();
    const fromStatus = currentLead?.status || null;

    const { error } = await db.from('leads').update({
      status,
      lost_reason: lostReason || null,
      updated_at: now
    }).eq('id', cleanId);
    if (error) throw error;

    if (fromStatus && fromStatus !== status) {
      try {
        const historyDb = getHistoryDB();
        const { error: insertErr } = await historyDb.from('lead_status_history').insert([{
          lead_id: cleanId,
          from_status: fromStatus,
          to_status: status,
          changed_by_user_id: changedByUserId || null,
          lost_reason: lostReason || null,
          comment: comment || null,
          created_at: now
        }]);
        if (insertErr) throw insertErr;
      } catch (histErr) {
        console.error('[LeadsRepository] Status history recording failed:', {
          leadId: cleanId,
          fromStatus,
          toStatus: status,
          hasReason: Boolean(lostReason),
          errorCode: histErr?.code || 'UNKNOWN',
          errorMessage: histErr?.message
            ? String(histErr.message)
                .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
                .replace(/\+?\d[\d -]{7,}\d/g, '[REDACTED_PHONE]')
            : 'No error message'
        });
      }
    }

    return this.findById(cleanId);
  }

  static async getStatusHistory(leadId) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');
    const db = getHistoryDB();
    try {
      const { data, error } = await db
        .from('lead_status_history')
        .select('*, users!changed_by_user_id(name)')
        .eq('lead_id', cleanId)
        .order('created_at', { ascending: false });
      if (error) {
        console.warn('[LeadsRepository] Failed to query status history:', {
          leadId: cleanId,
          errorCode: error.code || 'UNKNOWN'
        });
        return [];
      }
      return (data || []).map(h => ({
        ...h,
        changed_by_user_name: h.users?.name || 'Система',
        users: undefined
      }));
    } catch {
      return [];
    }
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

  static async getSlaControlData(filters = {}, currentUser) {
    if (!currentUser) throw new AppError('Пользователь не авторизован', 401);

    if (currentUser.role === 'FINANCE_MANAGER') {
      throw new AppError('Доступ к контролю лидов разрешен только менеджерам по продажам и руководству', 403);
    }

    const isManagerOnly = currentUser.role === 'SALES_MANAGER';
    const db = getDB();
    const today = getBusinessDate();
    const now = new Date();

    let query = db
      .from('leads')
      .select(`
        id,
        full_name,
        phone,
        status,
        source,
        responsible_user_id,
        interested_project_id,
        created_at,
        updated_at,
        users!responsible_user_id ( id, name, role ),
        projects!interested_project_id ( id, name ),
        lead_notes ( id, author_user_id, body, created_at ),
        tasks ( id, title, type, priority, status, due_date, completed_at ),
        deals ( id, contract_number, status )
      `)
      .is('archived_at', null)
      .in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION'])
      .order('created_at', { ascending: false });

    if (isManagerOnly) {
      query = query.eq('responsible_user_id', currentUser.id);
    } else if (filters.responsibleUserId && filters.responsibleUserId !== 'ALL') {
      const parsedUserId = parseOptionalBigInt(filters.responsibleUserId);
      if (parsedUserId) query = query.eq('responsible_user_id', parsedUserId);
    }

    if (filters.projectId && filters.projectId !== 'ALL') {
      const parsedProjectId = parseOptionalBigInt(filters.projectId);
      if (parsedProjectId) query = query.eq('interested_project_id', parsedProjectId);
    }

    const { data: rawLeads, error } = await query;
    if (error) throw error;

    let leads = rawLeads || [];

    // Evaluate SLA metrics for each lead
    const evaluatedLeads = leads.map(l => {
      const isUnassigned = !l.responsible_user_id;
      const notesList = l.lead_notes || [];
      const tasksList = l.tasks || [];
      const dealsList = l.deals || [];

      // Multi-signal contact check:
      // Status not NEW, or has notes, or has completed task, or has deals
      const hasCompletedTask = tasksList.some(t => t.status === 'COMPLETED');
      const hasNotes = notesList.length > 0;
      const hasDeals = dealsList.length > 0;
      const firstContactRecorded = (l.status !== 'NEW') || hasNotes || hasCompletedTask || hasDeals;

      // Contact signal label
      let firstContactSignal = null;
      if (l.status !== 'NEW') firstContactSignal = 'Смена стадии (' + l.status + ')';
      else if (hasNotes) firstContactSignal = 'Заметка менеджера';
      else if (hasCompletedTask) firstContactSignal = 'Выполнен звонок';
      else if (hasDeals) firstContactSignal = 'Создана бронь';

      const workingMinutesSinceCreation = calculateWorkingMinutes(l.created_at, now);

      // Tasks analysis
      const openTasks = tasksList.filter(t => t.status === 'OPEN');
      const overdueTasks = openTasks.filter(t => t.due_date && t.due_date < today);
      const hasOverdueTask = overdueTasks.length > 0;

      // Find next task
      let nextTask = null;
      if (openTasks.length > 0) {
        const sorted = [...openTasks].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
        nextTask = {
          id: sorted[0].id,
          title: sorted[0].title,
          type: sorted[0].type,
          due_date: sorted[0].due_date,
          is_overdue: sorted[0].due_date < today
        };
      }

      // Last activity
      let lastActivityAt = l.updated_at || l.created_at;
      let lastActivityType = 'Создание лида';
      notesList.forEach(n => {
        if (new Date(n.created_at) > new Date(lastActivityAt)) {
          lastActivityAt = n.created_at;
          lastActivityType = 'Заметка';
        }
      });
      tasksList.forEach(t => {
        if (t.completed_at && new Date(t.completed_at) > new Date(lastActivityAt)) {
          lastActivityAt = t.completed_at;
          lastActivityType = 'Выполнение задачи';
        }
      });

      const hoursSinceLastActivity = Math.max(0, Math.floor((now.getTime() - new Date(lastActivityAt).getTime()) / 3600000));

      // SLA Status determination
      let slaStatus = 'ON_TRACK';
      let slaBadge = { label: 'В графике', color: 'emerald', level: 'NORMAL' };

      if (isUnassigned) {
        slaStatus = 'UNASSIGNED';
        slaBadge = { label: 'Требует назначения', color: 'rose', level: 'CRITICAL' };
      } else if (l.status === 'NEW' && !firstContactRecorded) {
        if (workingMinutesSinceCreation >= 120) {
          slaStatus = 'OVERDUE_CONTACT';
          slaBadge = { label: `Просрочен контакт (${formatWorkingDuration(workingMinutesSinceCreation)})`, color: 'rose', level: 'CRITICAL' };
        } else if (workingMinutesSinceCreation >= 60) {
          slaStatus = 'WARNING_CONTACT';
          slaBadge = { label: `Ожидает контакта (${formatWorkingDuration(workingMinutesSinceCreation)})`, color: 'amber', level: 'WARNING' };
        } else {
          slaStatus = 'NEW_IN_TIME';
          slaBadge = { label: `Новый (${formatWorkingDuration(workingMinutesSinceCreation)})`, color: 'blue', level: 'NORMAL' };
        }
      } else if (hasOverdueTask) {
        slaStatus = 'OVERDUE_TASK';
        slaBadge = { label: 'Просрочена задача', color: 'rose', level: 'CRITICAL' };
      } else if (['IN_PROGRESS', 'NEGOTIATION'].includes(l.status) && openTasks.length === 0 && hoursSinceLastActivity >= 48) {
        slaStatus = 'STAGNANT';
        slaBadge = { label: `Без движения (${Math.floor(hoursSinceLastActivity / 24)} дн.)`, color: 'amber', level: 'WARNING' };
      }

      return {
        id: l.id,
        full_name: l.full_name,
        phone: l.phone,
        status: l.status,
        source: l.source,
        responsible_user_id: l.responsible_user_id,
        responsible_user_name: l.users?.name || (isUnassigned ? 'Не назначен' : 'Сотрудник'),
        project_name: l.projects?.name || null,
        created_at: l.created_at,
        first_contact_recorded: firstContactRecorded,
        first_contact_signal: firstContactSignal,
        working_minutes_elapsed: workingMinutesSinceCreation,
        working_duration_formatted: formatWorkingDuration(workingMinutesSinceCreation),
        last_activity_at: lastActivityAt,
        last_activity_type: lastActivityType,
        hours_since_last_activity: hoursSinceLastActivity,
        next_task: nextTask,
        open_tasks_count: openTasks.length,
        notes_count: notesList.length,
        sla_status: slaStatus,
        sla_badge: slaBadge,
        action_url: `/clients?clientId=${l.id}`
      };
    });

    // Summary counters (computed over all active accessible leads)
    const summary = {
      totalActive: evaluatedLeads.length,
      unassignedCount: evaluatedLeads.filter(l => l.sla_status === 'UNASSIGNED').length,
      contactWarningCount: evaluatedLeads.filter(l => l.sla_status === 'WARNING_CONTACT').length,
      contactOverdueCount: evaluatedLeads.filter(l => l.sla_status === 'OVERDUE_CONTACT').length,
      stagnantCount: evaluatedLeads.filter(l => l.sla_status === 'STAGNANT').length,
      overdueTasksCount: evaluatedLeads.filter(l => l.sla_status === 'OVERDUE_TASK').length,
      onTrackCount: evaluatedLeads.filter(l => ['ON_TRACK', 'NEW_IN_TIME'].includes(l.sla_status)).length,
      attentionRequiredCount: evaluatedLeads.filter(l => ['UNASSIGNED', 'WARNING_CONTACT', 'OVERDUE_CONTACT', 'STAGNANT', 'OVERDUE_TASK'].includes(l.sla_status)).length
    };

    // Filter results
    let filteredLeads = evaluatedLeads;

    if (filters.slaStatus && filters.slaStatus !== 'ALL') {
      if (filters.slaStatus === 'ATTENTION_REQUIRED') {
        filteredLeads = filteredLeads.filter(l => ['UNASSIGNED', 'WARNING_CONTACT', 'OVERDUE_CONTACT', 'STAGNANT', 'OVERDUE_TASK'].includes(l.sla_status));
      } else {
        filteredLeads = filteredLeads.filter(l => l.sla_status === filters.slaStatus);
      }
    }

    if (filters.search) {
      const q = filters.search.toLowerCase().trim();
      filteredLeads = filteredLeads.filter(l =>
        (l.full_name && l.full_name.toLowerCase().includes(q)) ||
        (l.phone && l.phone.toLowerCase().includes(q))
      );
    }

    // Pagination
    const page = Math.max(1, parseInt(filters.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(filters.limit || '50', 10)));
    const total = filteredLeads.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const offset = (page - 1) * limit;
    const paginatedLeads = filteredLeads.slice(offset, offset + limit);

    return {
      summary,
      leads: paginatedLeads,
      pagination: {
        total,
        page,
        limit,
        totalPages
      }
    };
  }
}
