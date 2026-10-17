import { getDB, getServiceDB } from '../../db/connection.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';
import { matchSearchQuery } from '../../utils/searchUtils.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { evaluateLeadSla } from './leadSla.service.js';
import { getBusinessDate } from '../../utils/businessTime.js';

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
    let query = db
      .from('leads')
      .select('*, users!responsible_user_id(name), projects!interested_project_id(name), lead_notes(id), deals(id)')
      .is('archived_at', null)
      .order('created_at', { ascending: false });

    // Status filtering
    if (filters.status && filters.status !== 'ALL') {
      if (filters.status === 'UNASSIGNED') {
        query = query.is('responsible_user_id', null).in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION']);
      } else {
        query = query.eq('status', filters.status);
      }
    }

    if (filters.unassigned === true || filters.unassigned === 'true') {
      query = query.is('responsible_user_id', null).in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION']);
    }

    // Quick filters from 7 dashboard cards
    if (filters.quickFilter) {
      if (filters.quickFilter === 'NEW') {
        query = query.eq('status', 'NEW');
      } else if (filters.quickFilter === 'UNASSIGNED') {
        query = query.is('responsible_user_id', null).in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION']);
      } else if (filters.quickFilter === 'IN_PROGRESS') {
        query = query.in('status', ['IN_PROGRESS', 'NEGOTIATION']);
      } else if (filters.quickFilter === 'CLOSED') {
        query = query.in('status', ['WON', 'LOST']);
      }
    }

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

    // Map and evaluate SLA metrics for each lead
    let mappedLeads = leads.map(l => {
      const sla_info = evaluateLeadSla(l);
      return {
        ...l,
        responsible_user_name: l.users?.name || (l.responsible_user_id ? 'Менеджер' : (['WON', 'LOST'].includes(l.status) ? '—' : 'Не назначен (В пуле)')),
        interested_project_name: l.projects?.name,
        notes_count: l.lead_notes?.length || 0,
        deals_count: l.deals?.length || 0,
        sla_info,
        users: undefined,
        projects: undefined,
        lead_notes: undefined,
        deals: undefined
      };
    });

    // Post-query filtering for virtual SLA conditions
    if (filters.quickFilter === 'AWAITING_CONTACT') {
      mappedLeads = mappedLeads.filter(l => l.status === 'NEW' && !l.first_contact_at);
    } else if (filters.quickFilter === 'OVERDUE') {
      mappedLeads = mappedLeads.filter(l => 
        !['WON', 'LOST'].includes(l.status) &&
        (l.sla_info?.manager_sla?.is_overdue || l.sla_info?.pool_sla?.is_overdue)
      );
    }

    return mappedLeads;
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
    const assignment_history = await this.getAssignmentHistory(cleanId);
    const sla_info = evaluateLeadSla(lead);

    return {
      ...lead,
      responsible_user_name: lead.users?.name || (lead.responsible_user_id ? 'Менеджер' : 'Не назначен (В пуле)'),
      interested_project_name: lead.projects?.name || null,
      notes_list,
      deals_list,
      status_history,
      assignment_history,
      sla_info,
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

    // Phase 2: SLA, assignment, deduplication fields
    if (data.assigned_at !== undefined) payload.assigned_at = data.assigned_at || null;
    if (data.first_contact_at !== undefined) payload.first_contact_at = data.first_contact_at || null;
    if (data.first_contact_by_user_id !== undefined) payload.first_contact_by_user_id = parseOptionalBigInt(data.first_contact_by_user_id);
    if (data.first_contact_outcome !== undefined) payload.first_contact_outcome = data.first_contact_outcome || null;
    if (data.reassignment_reason !== undefined) payload.reassignment_reason = data.reassignment_reason || null;
    if (data.idempotency_key !== undefined) payload.idempotency_key = data.idempotency_key || null;

    return payload;
  }

  static async create(data) {
    const db = getDB();
    const now = new Date().toISOString();
    const prepared = this._prepareLeadData(data);
    prepared.created_at = now;
    prepared.updated_at = now;

    // If assigned upon creation, set assigned_at
    if (prepared.responsible_user_id && !prepared.assigned_at) {
      prepared.assigned_at = now;
    }

    const { data: lead, error } = await db.from('leads').insert([prepared]).select().single();
    if (error) throw error;

    // Trigger internal notification for new lead (notifies admin and responsible manager)
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

    const { data: currentLead } = await db.from('leads').select('status, first_contact_at').eq('id', cleanId).maybeSingle();
    const fromStatus = currentLead?.status || null;

    const updatePayload = {
      status,
      lost_reason: lostReason || null,
      updated_at: now
    };

    // If advancing beyond NEW for the first time without recorded contact, mark first contact now
    if (fromStatus === 'NEW' && status !== 'NEW' && !currentLead?.first_contact_at) {
      updatePayload.first_contact_at = now;
      updatePayload.first_contact_by_user_id = changedByUserId || null;
      updatePayload.first_contact_outcome = 'STAGE_ADVANCED';
    }

    const { error } = await db.from('leads').update(updatePayload).eq('id', cleanId);
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
        console.error('[LeadsRepository] Status history recording failed:', histErr?.message || histErr);
      }
    }

    return this.findById(cleanId);
  }

  /**
   * Assign or reassign lead to a manager or return to pool.
   * Validates target user is an active sales representative (is_sales_rep = true).
   */
  static async assignManager(leadId, targetUserId, reason = null, actorUserId = null) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');
    const db = getDB();
    const now = new Date().toISOString();

    const currentLead = await this.findById(cleanId);
    if (!currentLead) throw new AppError('Лид не найден', 404);

    const fromUserId = currentLead.responsible_user_id || null;
    const cleanTargetId = targetUserId !== null && targetUserId !== undefined ? parseRequiredBigInt(targetUserId, 'targetUserId') : null;

    if (cleanTargetId !== null) {
      // Validate target user eligibility
      const { data: targetUser, error: userErr } = await db
        .from('users')
        .select('id, name, role, is_active, is_sales_rep')
        .eq('id', cleanTargetId)
        .maybeSingle();

      if (userErr || !targetUser) {
        throw new AppError('Указанный менеджер не найден', 404);
      }

      const isActive = targetUser.is_active === 1 || targetUser.is_active === true || targetUser.is_active === '1';
      if (!isActive) {
        throw new AppError('Назначение невозможно: учетная запись сотрудника деактивирована', 422);
      }

      const isRep = targetUser.is_sales_rep === true || targetUser.is_sales_rep === 1 || targetUser.is_sales_rep === 'true';
      if (!isRep) {
        throw new AppError('Назначение разрешено только действующему сотруднику отдела продаж (is_sales_rep = true)', 422);
      }
    }

    // Update lead record
    const updatePayload = {
      responsible_user_id: cleanTargetId,
      assigned_at: cleanTargetId ? now : null,
      reassignment_reason: reason || null,
      updated_at: now
    };

    const { error: updateErr } = await db.from('leads').update(updatePayload).eq('id', cleanId);
    if (updateErr) throw updateErr;

    // Log assignment transition into assignment history table (best effort, graceful fallback)
    try {
      const historyDb = getHistoryDB();
      await historyDb.from('lead_assignment_history').insert([{
        lead_id: cleanId,
        from_user_id: fromUserId,
        to_user_id: cleanTargetId,
        assigned_by_user_id: actorUserId || null,
        assignment_type: cleanTargetId ? 'MANUAL' : 'POOL_RETURN',
        reason: reason || null,
        created_at: now
      }]);
    } catch (logErr) {
      console.warn('[LeadsRepository] Assignment history logging skipped/failed:', logErr?.message || logErr);
    }

    const updatedLead = await this.findById(cleanId);

    // If assigned to a manager, trigger call task and in-app notification
    if (cleanTargetId) {
      TasksService.onLeadAssigned(updatedLead, cleanTargetId, actorUserId).catch(err => {
        console.warn('Failed to generate call task on lead assigned:', err);
      });

      NotificationsService.notifyLeadAssigned(updatedLead, cleanTargetId, actorUserId).catch(err => {
        console.warn('Failed to dispatch LEAD_ASSIGNED notification:', err);
      });
    }

    return updatedLead;
  }

  /**
   * Records first contact outcome, resolving 15-minute SLA.
   */
  static async recordFirstContact(leadId, actorUserId, details = {}) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');
    const db = getDB();
    const now = new Date().toISOString();

    const currentLead = await this.findById(cleanId);
    if (!currentLead) throw new AppError('Лид не найден', 404);

    const outcome = details.outcome || 'REACHED'; // REACHED, NO_ANSWER, CALLBACK_REQUESTED, INVALID_NUMBER
    const comment = details.comment ? String(details.comment).trim() : '';

    const updatePayload = {
      first_contact_at: now,
      first_contact_by_user_id: actorUserId || null,
      first_contact_outcome: outcome,
      updated_at: now
    };

    // If currently NEW and reached, auto-advance to IN_PROGRESS unless specified
    if (currentLead.status === 'NEW') {
      if (details.status) {
        updatePayload.status = details.status;
      } else if (outcome === 'REACHED') {
        updatePayload.status = 'IN_PROGRESS';
      }
    }

    const { error: updateErr } = await db.from('leads').update(updatePayload).eq('id', cleanId);
    if (updateErr) throw updateErr;

    // Add note to lead notes
    const outcomeLabels = {
      REACHED: 'Успешный контакт',
      NO_ANSWER: 'Не отвечает / Сброс',
      CALLBACK_REQUESTED: 'Просьба перезвонить',
      INVALID_NUMBER: 'Неверный номер / Ошибка'
    };
    const noteText = `Первый контакт [${outcomeLabels[outcome] || outcome}]${comment ? `: ${comment}` : ''}`;
    await this.addNote(cleanId, actorUserId || 1, noteText);

    // Complete open call tasks
    await TasksService.onFirstContactRecorded(cleanId);

    return this.findById(cleanId);
  }

  /**
   * Queries lead assignment history
   */
  static async getAssignmentHistory(leadId) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');
    const db = getHistoryDB();
    try {
      const { data, error } = await db
        .from('lead_assignment_history')
        .select('*, from_user:from_user_id(name), to_user:to_user_id(name), assigned_by:assigned_by_user_id(name)')
        .eq('lead_id', cleanId)
        .order('created_at', { ascending: false });

      if (error) return [];
      return (data || []).map(h => ({
        ...h,
        from_user_name: h.from_user?.name || (h.from_user_id ? 'Сотрудник' : 'Общий пул'),
        to_user_name: h.to_user?.name || (h.to_user_id ? 'Сотрудник' : 'Общий пул'),
        assigned_by_name: h.assigned_by?.name || 'Система',
        from_user: undefined,
        to_user: undefined,
        assigned_by: undefined
      }));
    } catch {
      return [];
    }
  }

  /**
   * Finds recent lead created with same phone within windowMinutes (for webhook deduplication)
   */
  static async findRecentByPhone(phone, windowMinutes = 10) {
    if (!phone) return null;
    const cleanDigits = String(phone).replace(/\D/g, '');
    if (cleanDigits.length < 7) return null;

    const db = getDB();
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

    const { data, error } = await db
      .from('leads')
      .select('id, full_name, phone, status, created_at, responsible_user_id')
      .gte('created_at', cutoff)
      .is('archived_at', null)
      .order('created_at', { ascending: false });

    if (error || !data) return null;

    return data.find(l => {
      const lDigits = String(l.phone || '').replace(/\D/g, '');
      return lDigits === cleanDigits || lDigits.endsWith(cleanDigits) || cleanDigits.endsWith(lDigits);
    }) || null;
  }

  /**
   * Finds existing active lead (NEW, IN_PROGRESS, NEGOTIATION) with same phone (for repeat inquiries)
   */
  static async findActiveByPhone(phone) {
    if (!phone) return null;
    const cleanDigits = String(phone).replace(/\D/g, '');
    if (cleanDigits.length < 7) return null;

    const db = getDB();
    const { data, error } = await db
      .from('leads')
      .select('id, full_name, phone, status, created_at, responsible_user_id')
      .in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION'])
      .is('archived_at', null)
      .order('created_at', { ascending: false });

    if (error || !data) return null;

    return data.find(l => {
      const lDigits = String(l.phone || '').replace(/\D/g, '');
      return lDigits === cleanDigits || lDigits.endsWith(cleanDigits) || cleanDigits.endsWith(lDigits);
    }) || null;
  }

  /**
   * Finds lead by webhook idempotency key
   */
  static async findByIdempotencyKey(key) {
    if (!key) return null;
    const db = getDB();
    const { data, error } = await db
      .from('leads')
      .select('id, full_name, phone, status, created_at, responsible_user_id')
      .eq('idempotency_key', String(key).trim())
      .is('archived_at', null)
      .maybeSingle();

    if (error || !data) return null;
    return data;
  }

  /**
   * Summary metrics for the 7 dashboard cards
   */
  static async getPoolStats(currentUser) {
    const db = getDB();
    let query = db
      .from('leads')
      .select('id, status, responsible_user_id, created_at, assigned_at, first_contact_at')
      .is('archived_at', null);

    // Sales managers only see stats for their own scope
    const isSalesManager = currentUser?.role === 'SALES_MANAGER';
    if (isSalesManager) {
      query = query.eq('responsible_user_id', currentUser.id);
    }

    const { data: rawLeads, error } = await query;
    if (error) throw error;

    const leads = rawLeads || [];
    let unassigned = 0;
    let newCount = 0;
    let awaitingContact = 0;
    let overdueCount = 0;
    let inProgress = 0;
    let closed = 0;

    leads.forEach(l => {
      const isClosedLead = ['WON', 'LOST'].includes(l.status);
      const isUnassignedLead = !l.responsible_user_id && !isClosedLead;
      const sla = evaluateLeadSla(l);

      if (isUnassignedLead) {
        unassigned++;
      }
      if (l.status === 'NEW') {
        newCount++;
        if (!l.first_contact_at) {
          awaitingContact++;
        }
      }
      if (['IN_PROGRESS', 'NEGOTIATION'].includes(l.status)) {
        inProgress++;
      }
      if (isClosedLead) {
        closed++;
      }
      if (!isClosedLead && (sla.manager_sla.is_overdue || (isUnassignedLead && sla.pool_sla.is_overdue))) {
        overdueCount++;
      }
    });

    return {
      total: leads.length,
      new: newCount,
      unassigned: isSalesManager ? 0 : unassigned,
      awaiting_contact: awaitingContact,
      overdue: overdueCount,
      in_progress: inProgress,
      closed
    };
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
      if (error) return [];
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
    const { data: note } = await db
      .from('lead_notes')
      .insert([{ lead_id: leadId, author_user_id: authorUserId, body, created_at: now }])
      .select('*, users!author_user_id(name)')
      .single();
    return { ...note, author_name: note.users?.name, users: undefined };
  }

  static async archive(id) {
    const db = getDB();
    const now = new Date().toISOString();
    await db.from('leads').update({ archived_at: now }).eq('id', id);
  }

  static async getSlaControlData(filters = {}, currentUser) {
    if (!currentUser) throw new AppError('Пользователь не авторизован', 401);

    if (['FINANCE_MANAGER', 'WAREHOUSE_MANAGER'].includes(currentUser.role)) {
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
        assigned_at,
        first_contact_at,
        first_contact_outcome,
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

    // Evaluate SLA metrics using the canonical 15-minute leadSla service
    const evaluatedLeads = leads.map(l => {
      const sla = evaluateLeadSla(l, now);
      const notesList = l.lead_notes || [];
      const tasksList = l.tasks || [];
      const openTasks = tasksList.filter(t => t.status === 'OPEN');
      const overdueTasks = openTasks.filter(t => t.due_date && t.due_date < today);
      const hasOverdueTask = overdueTasks.length > 0;

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

      let effectiveSlaStatus = sla.overall_status;
      let effectiveBadge = sla.badge;

      if (hasOverdueTask) {
        effectiveSlaStatus = 'OVERDUE_TASK';
        effectiveBadge = { label: 'Просрочена задача', color: 'rose', level: 'CRITICAL' };
      } else if (['IN_PROGRESS', 'NEGOTIATION'].includes(l.status) && openTasks.length === 0 && hoursSinceLastActivity >= 48) {
        effectiveSlaStatus = 'STAGNANT';
        effectiveBadge = { label: `Без движения (${Math.floor(hoursSinceLastActivity / 24)} дн.)`, color: 'amber', level: 'WARNING' };
      }

      return {
        id: l.id,
        full_name: l.full_name,
        phone: l.phone,
        status: l.status,
        source: l.source,
        responsible_user_id: l.responsible_user_id,
        responsible_user_name: l.users?.name || (l.responsible_user_id ? 'Сотрудник' : 'Не назначен (В пуле)'),
        project_name: l.projects?.name || null,
        created_at: l.created_at,
        assigned_at: l.assigned_at || null,
        first_contact_at: l.first_contact_at || null,
        first_contact_recorded: Boolean(sla.manager_sla.contact_made),
        sla_info: sla,
        sla_status: effectiveSlaStatus,
        sla_badge: effectiveBadge,
        last_activity_at: lastActivityAt,
        last_activity_type: lastActivityType,
        hours_since_last_activity: hoursSinceLastActivity,
        next_task: nextTask,
        open_tasks_count: openTasks.length,
        notes_count: notesList.length,
        action_url: `/clients?clientId=${l.id}`
      };
    });

    // Summary counters
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

    const page = Math.max(1, parseInt(filters.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(filters.limit || '50', 10)));
    const total = filteredLeads.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const offset = (page - 1) * limit;
    const paginatedLeads = filteredLeads.slice(offset, offset + limit);

    return {
      summary,
      leads: paginatedLeads,
      pagination: { total, page, limit, totalPages }
    };
  }
}
