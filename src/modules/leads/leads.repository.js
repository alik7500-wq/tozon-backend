import { getDB, getServiceDB } from '../../db/connection.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';
import { matchSearchQuery } from '../../utils/searchUtils.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OutboxWorkerService } from '../outbox/outboxWorker.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { TasksRepository } from '../tasks/tasks.repository.js';
import { InventoryRepository } from '../inventory/inventory.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { evaluateLeadSla } from './leadSla.service.js';
import { getBusinessDate } from '../../utils/businessTime.js';
import {
  resolveCanonicalStage,
  mapStageToLegacyStatus,
  validateStageTransition,
  classifyCommunicationEffect,
  COMMUNICATION_EVENT_TYPES
} from './leadDomain.js';
import {
  validateAndNormalizeLeadQuery,
  encodeLeadCursor,
  computeFilterHash
} from './leadFilterValidator.js';

const getHistoryDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

const getSecureDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

const activeLeadAssignmentLocks = new Set();

export class LeadsRepository {
  static async queryUnified(query = {}, user = {}) {
    const { dbFilters, dbScope, filterHash, scope } = validateAndNormalizeLeadQuery(query, user);

    if (scope.restrictedToSelf && dbFilters.quick_filter === 'UNASSIGNED') {
      const emptyBoardColumns = dbFilters.board_per_stage_limit > 0
        ? Object.fromEntries(
            ['NEW', 'IN_PROGRESS', 'NEGOTIATION', 'MEETING_SCHEDULED', 'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP', 'SIGNED', 'LOST']
              .map((st) => [st, { leads: [], total: 0, nextCursor: null }])
          )
        : undefined;
      return {
        leads: [],
        total: 0,
        nextCursor: null,
        ...(emptyBoardColumns ? { boardColumns: emptyBoardColumns } : {}),
        stats: { total: 0, new: 0, unassigned: 0, awaiting_contact: 0, overdue: 0, in_progress: 0, closed: 0, no_task: 0, unread: 0 },
        stageCounts: { NEW: 0, IN_PROGRESS: 0, NEGOTIATION: 0, MEETING_SCHEDULED: 0, SHOWING_DONE: 0, RESERVED: 0, CONTRACT_PREP: 0, SIGNED: 0, LOST: 0 },
        appliedFilters: dbFilters,
        scope: { role: scope.role, restrictedToSelf: true },
        generatedAt: new Date().toISOString()
      };
    }

    const secureDb = getSecureDB();
    const { data, error } = await secureDb.rpc('fn_query_leads_unified', {
      p_filters: dbFilters,
      p_scope: dbScope
    });

    if (error || !data) {
      throw new AppError('Сервис фильтрации лидов временно недоступен', 503);
    }

    const leads = Array.isArray(data.leads) ? data.leads : [];
    const total = Number(data.total || 0);
    const hasMore = dbFilters.limit > 0 && leads.length === dbFilters.limit;
    const nextCursor = hasMore ? encodeLeadCursor(leads[leads.length - 1], filterHash) : null;

    let boardColumns;
    if (dbFilters.board_per_stage_limit > 0 && data.board_columns && typeof data.board_columns === 'object') {
      boardColumns = {};
      for (const [stageKey, colData] of Object.entries(data.board_columns)) {
        const colLeads = Array.isArray(colData?.leads) ? colData.leads : [];
        const colTotal = Number(colData?.total || 0);
        const colHasMore = colLeads.length === dbFilters.board_per_stage_limit && colTotal > colLeads.length;
        const stageHash = computeFilterHash({ ...dbFilters, stage: stageKey });
        boardColumns[stageKey] = {
          leads: colLeads,
          total: colTotal,
          nextCursor: colHasMore ? encodeLeadCursor(colLeads[colLeads.length - 1], stageHash) : null
        };
      }
    }

    return {
      leads,
      total,
      nextCursor,
      ...(boardColumns ? { boardColumns } : {}),
      stats: data.stats || {},
      stageCounts: data.stage_counts || {},
      appliedFilters: dbFilters,
      scope: { role: scope.role, restrictedToSelf: scope.restrictedToSelf },
      generatedAt: new Date().toISOString()
    };
  }

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

    const raw_notes_list = (lead.lead_notes || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const notes_list = raw_notes_list.filter(n => !n.body?.startsWith('[UNIT_INTEREST'));
    const deals_list = (lead.deals || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const status_history = await this.getStatusHistory(cleanId);
    const assignment_history = await this.getAssignmentHistory(cleanId);
    const sla_info = evaluateLeadSla(lead);
    const interested_units = await this.getInterestedUnits(cleanId);

    return {
      ...lead,
      responsible_user_name: lead.users?.name || (lead.responsible_user_id ? 'Менеджер' : 'Не назначен (В пуле)'),
      interested_project_name: lead.projects?.name || null,
      notes_list,
      deals_list,
      status_history,
      assignment_history,
      sla_info,
      interested_units,
      interested_units_count: interested_units.length,
      users: undefined,
      projects: undefined,
      lead_notes: undefined,
      deals: undefined
    };
  }

  static _prepareLeadData(data) {
    const payload = {};
    if (data.sms_language !== undefined) {
      if (!['tj', 'ru'].includes(data.sms_language)) {
        throw new Error('Недопустимый язык SMS: разрешены tj или ru');
      }
      payload.sms_language = data.sms_language;
    }
    
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

    if (!(await OutboxWorkerService.isOutboxWorkerActive())) {
      // Legacy direct notification fallback when outbox worker is not active
      NotificationsService.notifyLeadCreated(lead).catch(err => {
        console.warn('Failed to dispatch LEAD_CREATED notification:', err);
      });
    }

    return this.findById(lead.id);
  }

  static _prepareLeadEditData(data) {
    const payload = {};
    if (data.full_name !== undefined) payload.full_name = data.full_name;
    if (data.phone !== undefined) payload.phone = data.phone;
    if (data.secondary_phone !== undefined) payload.secondary_phone = data.secondary_phone || null;
    if (data.source !== undefined) payload.source = data.source || 'DIRECT';
    if (data.source_code !== undefined) payload.source_code = data.source_code || null;
    if (data.interested_project_id !== undefined) payload.interested_project_id = parseOptionalBigInt(data.interested_project_id);
    if (data.budget_min_minor !== undefined) payload.budget_min_minor = data.budget_min_minor || null;
    if (data.budget_max_minor !== undefined) payload.budget_max_minor = data.budget_max_minor || null;
    if (data.notes !== undefined) payload.notes = data.notes || null;
    if (data.passport_series !== undefined) payload.passport_series = data.passport_series || null;
    if (data.passport_number !== undefined) payload.passport_number = data.passport_number || null;
    if (data.passport_issued_by !== undefined) payload.passport_issued_by = data.passport_issued_by || null;
    if (data.passport_issue_date !== undefined) payload.passport_issue_date = data.passport_issue_date || null;
    if (data.birth_date !== undefined) payload.birth_date = data.birth_date || null;
    if (data.registration_address !== undefined) payload.registration_address = data.registration_address || null;
    if (data.inn !== undefined) payload.inn = data.inn || null;
    if (data.utm_data !== undefined) payload.utm_data = data.utm_data || null;
    return payload;
  }

  static async update(id, data) {
    if (data && (data.status !== undefined || data.stage !== undefined)) {
      throw new AppError('Прямое изменение этапа/статуса лида запрещено. Используйте PATCH /api/leads/:id/status', 400);
    }
    // Phone changes revoke private buyer-portal access in the same transaction.
    // Route authorization runs before this server-only write; never fall back to anon.
    const db = getServiceDB();
    const now = new Date().toISOString();
    const prepared = this._prepareLeadEditData(data || {});
    if (Object.keys(prepared).length === 0) {
      return this.findById(id);
    }
    prepared.updated_at = now;

    const { error } = await db.from('leads').update(prepared).eq('id', id);
    if (error) throw error;

    return this.findById(id);
  }

  static async updateStatus(id, status, lostReason = null, comment = null, changedByUserId = null, options = {}) {
    const cleanId = parseRequiredBigInt(id, 'id');
    const secureDb = getSecureDB();

    const { data: rpcResult, error: rpcErr } = await secureDb.rpc('fn_update_lead_stage_atomic', {
      p_lead_id: cleanId,
      p_target_stage: status,
      p_lost_reason: lostReason || null,
      p_comment: comment || null,
      p_actor_user_id: changedByUserId ? Number(changedByUserId) : null,
      p_expected_version: options.expectedVersion !== undefined && options.expectedVersion !== null ? Number(options.expectedVersion) : null,
      p_idempotency_key: options.idempotencyKey || null,
      p_meeting_at: options.meetingAt || null,
      p_showing_project_id: options.showingProjectId ? Number(options.showingProjectId) : null,
      p_showing_at: options.showingAt || null,
      p_showing_outcome: options.showingOutcome || null
    });

    // Fail-closed: NEVER bypass concurrency protection with an unguarded direct UPDATE when RPC errors
    if (rpcErr || !rpcResult) {
      throw new AppError('Сервис атомарного изменения этапа временно недоступен', 503);
    }

    if (!rpcResult.success) {
      const code = Number(rpcResult.status_code) || 400;
      const err = new AppError(rpcResult.message || 'Ошибка изменения этапа лида', code);
      err.code = rpcResult.error_code;
      if (code === 409) {
        err.current = await this.findById(cleanId);
      }
      throw err;
    }

    const updatedLead = await this.findById(cleanId);
    if (rpcResult.replayed && updatedLead) {
      updatedLead._replayed = true;
    }
    return updatedLead;
  }

  /**
   * Assign or reassign lead to a manager or return to pool.
   * Validates target user is an active sales representative (is_sales_rep = true).
   * Concurrency-guarded to prevent parallel overwrites of the same lead.
   */
  static async assignManager(leadId, targetUserId, reason = null, actorUserId = null, isManual = true, expectedVersion = null) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');
    const lockKey = String(cleanId);
    if (activeLeadAssignmentLocks.has(lockKey)) {
      throw new AppError('Операция назначения для данного лида уже выполняется параллельным запросом', 409);
    }
    activeLeadAssignmentLocks.add(lockKey);

    try {
      const cleanTargetId = targetUserId !== null && targetUserId !== undefined ? parseRequiredBigInt(targetUserId, 'targetUserId') : null;

      // Cross-instance safety: strictly require PostgreSQL atomic RPC (no unsafe fallback UPDATE)
      const secureDb = getSecureDB();
      const { data: rpcResult, error: rpcErr } = await secureDb.rpc('fn_assign_lead_atomic', {
        p_lead_id: cleanId,
        p_target_user_id: cleanTargetId,
        p_actor_user_id: actorUserId ? Number(actorUserId) : null,
        p_reason: reason || null,
        p_max_capacity: 25,
        p_is_manual: isManual !== false,
        p_expected_version: expectedVersion !== undefined && expectedVersion !== null ? Number(expectedVersion) : null
      });

      if (rpcErr || !rpcResult) {
        throw new AppError('Сервис атомарного назначения лида временно недоступен', 503);
      }

      if (rpcResult.success) {
        const updatedLead = await this.findById(cleanId);
        if (cleanTargetId && !(await OutboxWorkerService.isOutboxWorkerActive())) {
          TasksService.onLeadAssigned(updatedLead, cleanTargetId, actorUserId).catch(err => {
            console.warn('Failed to generate call task on lead assigned:', err);
          });
          NotificationsService.notifyLeadAssigned(updatedLead, cleanTargetId, actorUserId).catch(err => {
            console.warn('Failed to dispatch LEAD_ASSIGNED notification:', err);
          });
        }
        return updatedLead;
      }

      if (rpcResult.error_code === 'VERSION_CONFLICT') {
        const latest = await this.findById(cleanId);
        const conflictErr = new AppError(rpcResult.message || 'Конфликт версии при назначении лида', 409);
        conflictErr.current = latest;
        throw conflictErr;
      }
      throw new AppError(rpcResult.message || 'Ошибка назначения лида', 422);

      const db = getDB();
      const now = new Date().toISOString();

      const currentLead = await this.findById(cleanId);
      if (!currentLead) throw new AppError('Лид не найден', 404);

      const fromUserId = currentLead.responsible_user_id || null;

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

      // If assigned to a manager, trigger call task and in-app notification (legacy fallback when worker inactive)
      if (cleanTargetId && !(await OutboxWorkerService.isOutboxWorkerActive())) {
        TasksService.onLeadAssigned(updatedLead, cleanTargetId, actorUserId).catch(err => {
          console.warn('Failed to generate call task on lead assigned:', err);
        });

        NotificationsService.notifyLeadAssigned(updatedLead, cleanTargetId, actorUserId).catch(err => {
          console.warn('Failed to dispatch LEAD_ASSIGNED notification:', err);
        });
      }

      return updatedLead;
    } finally {
      activeLeadAssignmentLocks.delete(lockKey);
    }
  }

  static _clearAssignmentLocks() {
    activeLeadAssignmentLocks.clear();
  }

  /**
   * Records communication / first contact outcome without overwriting earlier timestamps (F-12, A17, A18).
   */
  static async recordFirstContact(leadId, actorUserId, details = {}) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');
    const db = getDB();
    const now = details.occurred_at ? new Date(details.occurred_at).toISOString() : new Date().toISOString();

    const currentLead = await this.findById(cleanId);
    if (!currentLead) throw new AppError('Лид не найден', 404);

    const outcome = String(details.outcome || 'REACHED').toUpperCase();
    const comment = details.comment ? String(details.comment).trim() : '';

    const eventTypeMap = {
      REACHED: COMMUNICATION_EVENT_TYPES.CONNECTED_CALL,
      CONNECTED_CALL: COMMUNICATION_EVENT_TYPES.CONNECTED_CALL,
      OUTBOUND_MESSAGE: COMMUNICATION_EVENT_TYPES.OUTBOUND_MESSAGE,
      NO_ANSWER: COMMUNICATION_EVENT_TYPES.NO_ANSWER,
      BUSY: COMMUNICATION_EVENT_TYPES.BUSY,
      CALLBACK_REQUESTED: COMMUNICATION_EVENT_TYPES.CONNECTED_CALL,
      INVALID_NUMBER: COMMUNICATION_EVENT_TYPES.ATTEMPT
    };
    const eventType = details.event_type || eventTypeMap[outcome] || COMMUNICATION_EVENT_TYPES.ATTEMPT;
    const effect = classifyCommunicationEffect(eventType);

    const updatePayload = {
      updated_at: new Date().toISOString()
    };

    // Never overwrite earlier timestamps (A17)
    if (effect.countsAsHumanAction && !currentLead.first_human_action_at) {
      updatePayload.first_human_action_at = now;
    }
    if (effect.countsAsFirstResponse && !currentLead.first_response_at) {
      updatePayload.first_response_at = now;
      if (!currentLead.first_contact_at) {
        updatePayload.first_contact_at = now;
        updatePayload.first_contact_by_user_id = actorUserId || null;
        updatePayload.first_contact_outcome = outcome;
      }
    }
    if (effect.countsAsConfirmedContact && !currentLead.first_contact_confirmed_at) {
      updatePayload.first_contact_confirmed_at = now;
    }

    // Only confirmed contact advances NEW -> IN_PROGRESS automatically (A18)
    if (currentLead.status === 'NEW' && effect.countsAsConfirmedContact) {
      updatePayload.status = 'IN_PROGRESS';
      updatePayload.stage = 'IN_PROGRESS';
    }

    const { error: updateErr } = await db.from('leads').update(updatePayload).eq('id', cleanId);
    if (updateErr) throw updateErr;

    // Record immutable communication event
    try {
      const historyDb = getHistoryDB();
      await historyDb.from('lead_communications').insert([{
        lead_id: cleanId,
        contact_id: currentLead.contact_id || null,
        actor_user_id: actorUserId || null,
        channel: details.channel || 'CALL',
        direction: details.direction || 'OUTBOUND',
        event_type: eventType,
        is_manual: details.is_manual !== false,
        occurred_at: now,
        project_id: details.project_id || currentLead.interested_project_id || null,
        unit_id: details.unit_id || null,
        outcome,
        notes: comment || null,
        idempotency_key: details.idempotency_key || null
      }]);
    } catch (commErr) {
      console.warn('[LeadsRepository] lead_communications insert skipped:', commErr?.message || commErr);
    }

    const outcomeLabels = {
      REACHED: 'Успешный контакт',
      CONNECTED_CALL: 'Состоявшийся разговор',
      OUTBOUND_MESSAGE: 'Исходящее сообщение',
      NO_ANSWER: 'Не отвечает / Сброс',
      BUSY: 'Занято',
      CALLBACK_REQUESTED: 'Просьба перезвонить',
      INVALID_NUMBER: 'Неверный номер / Ошибка'
    };
    const manualTag = details.is_manual !== false ? ' (введено вручную)' : '';
    const noteText = `Контакт${manualTag} [${outcomeLabels[outcome] || outcome}]${comment ? `: ${comment}` : ''}`;
    await this.addNote(cleanId, actorUserId || 1, noteText);

    if (effect.countsAsConfirmedContact) {
      await TasksService.onFirstContactRecorded(cleanId);
    }

    return this.findById(cleanId);
  }

  static async setPause(leadId, actorUserId, { pause_until, pause_reason }) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');
    if (!pause_until || !pause_reason || !String(pause_reason).trim()) {
      throw new AppError('Для постановки на паузу укажите дату пересмотра и причину', 400);
    }
    const db = getDB();
    const now = new Date().toISOString();
    const { error } = await db
      .from('leads')
      .update({
        pause_until: new Date(pause_until).toISOString(),
        pause_reason: String(pause_reason).trim(),
        pause_set_by: actorUserId || null,
        updated_at: now
      })
      .eq('id', cleanId);
    if (error) throw error;
    await this.addNote(cleanId, actorUserId || 1, `Пауза до ${pause_until}: ${String(pause_reason).trim()}`);
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

  /**
   * Returns list of interested units for a lead with enriched live inventory details
   */
  static async getInterestedUnits(leadId) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');

    // 1. Try formal table lead_interested_units
    try {
      const db = getSecureDB();
      const { data: rows, error } = await db
        .from('lead_interested_units')
        .select('*')
        .eq('lead_id', cleanId)
        .order('created_at', { ascending: false });

      if (!error && rows) {
        const enriched = await Promise.all(
          rows.map(async (row) => {
            const unit = await InventoryRepository.getUnitById(row.unit_id);
            const areaM2 = unit?.area_m2_x100 ? unit.area_m2_x100 / 100 : 0;
            const pricePerM2 = unit?.price_per_m2_minor ? Math.round(unit.price_per_m2_minor / 100) : 0;
            const totalPrice = unit?.manual_total_price_minor
              ? Math.round(unit.manual_total_price_minor / 100)
              : Math.round(areaM2 * pricePerM2);

            return {
              id: row.id,
              lead_id: cleanId,
              unit_id: row.unit_id,
              priority: row.priority || 'MEDIUM',
              comment: row.comment || '',
              next_contact_date: row.next_contact_date || null,
              created_at: row.created_at,
              unit: unit ? {
                id: unit.id,
                unit_number: unit.unit_number,
                status: unit.status,
                rooms: unit.rooms,
                areaM2,
                pricePerM2,
                totalPrice,
                floor_number: unit.floors?.floor_number,
                building_name: unit.floors?.sections?.buildings?.name || 'Блок Б',
                project_name: unit.floors?.sections?.buildings?.projects?.name || 'TOZON PLAZA',
                plan_image_url: unit.layout_types?.image_path || null,
                layout_name: unit.layout_types?.name || null
              } : null
            };
          })
        );
        return enriched.filter(e => e.unit !== null);
      }
    } catch {
      // Table doesn't exist, proceed to resilient fallback
    }

    // 2. Resilient fallback using lead_notes and tasks
    try {
      const db = getDB();
      const { data: notes, error } = await db
        .from('lead_notes')
        .select('*')
        .eq('lead_id', cleanId)
        .order('created_at', { ascending: true });

      if (error || !notes) return [];

      const activeMap = new Map();

      for (const note of notes) {
        const body = String(note.body || '').trim();
        if (body.startsWith('[UNIT_INTEREST]')) {
          try {
            const jsonPart = body.substring('[UNIT_INTEREST]'.length).trim();
            const data = JSON.parse(jsonPart);
            if (data.unit_id) {
              activeMap.set(String(data.unit_id), {
                id: note.id,
                lead_id: cleanId,
                unit_id: data.unit_id,
                priority: data.priority || 'MEDIUM',
                comment: data.comment || '',
                next_contact_date: data.next_contact_date || null,
                created_at: note.created_at,
                created_by_user_id: note.author_user_id
              });
            }
          } catch (pe) {
            console.warn('Error parsing unit interest note:', pe.message);
          }
        } else if (body.startsWith('[UNIT_INTEREST_DELETED]')) {
          try {
            const jsonPart = body.substring('[UNIT_INTEREST_DELETED]'.length).trim();
            const data = JSON.parse(jsonPart);
            if (data.unit_id) {
              activeMap.delete(String(data.unit_id));
            }
          } catch (pe) {
            console.warn('Error parsing deleted unit interest note:', pe.message);
          }
        }
      }

      const items = Array.from(activeMap.values());
      const enriched = await Promise.all(
        items.map(async (item) => {
          const unit = await InventoryRepository.getUnitById(item.unit_id);
          const areaM2 = unit?.area_m2_x100 ? unit.area_m2_x100 / 100 : 0;
          const pricePerM2 = unit?.price_per_m2_minor ? Math.round(unit.price_per_m2_minor / 100) : 0;
          const totalPrice = unit?.manual_total_price_minor
            ? Math.round(unit.manual_total_price_minor / 100)
            : Math.round(areaM2 * pricePerM2);

          return {
            ...item,
            unit: unit ? {
              id: unit.id,
              unit_number: unit.unit_number,
              status: unit.status,
              rooms: unit.rooms,
              areaM2,
              pricePerM2,
              totalPrice,
              floor_number: unit.floors?.floor_number,
              building_name: unit.floors?.sections?.buildings?.name || 'Блок Б',
              project_name: unit.floors?.sections?.buildings?.projects?.name || 'TOZON PLAZA',
              plan_image_url: unit.layout_types?.image_path || null,
              layout_name: unit.layout_types?.name || null
            } : null
          };
        })
      );

      return enriched.filter(e => e.unit !== null).reverse();
    } catch (e) {
      console.warn('Error fetching interested units fallback:', e.message);
      return [];
    }
  }

  /**
   * Adds or updates interest for a specific unit
   */
  static async addInterestedUnit(leadId, data, actorUser) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');
    const cleanUnitId = parseRequiredBigInt(data.unit_id, 'unit_id');
    const priority = ['HIGH', 'MEDIUM', 'LOW'].includes(data.priority) ? data.priority : 'MEDIUM';
    const comment = data.comment ? String(data.comment).trim() : '';
    const next_contact_date = data.next_contact_date || null;

    const unit = await InventoryRepository.getUnitById(cleanUnitId);
    if (!unit) throw new AppError('Квартира не найдена', 404);

    // Fetch lead details
    const lead = await this.findById(cleanId);
    if (!lead) throw new AppError('Лид не найден', 404);

    const now = new Date().toISOString();
    let interestRecord = null;

    // 1. Try formal table
    try {
      const db = getSecureDB();
      const { data: existingRow } = await db
        .from('lead_interested_units')
        .select('*')
        .eq('lead_id', cleanId)
        .eq('unit_id', cleanUnitId)
        .maybeSingle();

      if (existingRow) {
        const { data: updated } = await db
          .from('lead_interested_units')
          .update({
            priority,
            comment,
            next_contact_date,
            updated_at: now
          })
          .eq('id', existingRow.id)
          .select()
          .single();
        interestRecord = updated;
      } else {
        const { data: created } = await db
          .from('lead_interested_units')
          .insert([{
            lead_id: cleanId,
            unit_id: cleanUnitId,
            priority,
            comment,
            next_contact_date,
            created_by_user_id: actorUser?.id || null,
            created_at: now,
            updated_at: now
          }])
          .select()
          .single();
        interestRecord = created;
      }
    } catch {
      // Table doesn't exist, proceed to resilient fallback
    }

    // 2. Resilient fallback recording
    if (!interestRecord) {
      const payload = {
        unit_id: cleanUnitId,
        priority,
        comment,
        next_contact_date,
        created_at: now,
        created_by_user_id: actorUser?.id || null
      };
      await this.addNote(cleanId, actorUser?.id || 1, `[UNIT_INTEREST] ${JSON.stringify(payload)}`);
      interestRecord = {
        id: Date.now(),
        lead_id: cleanId,
        ...payload
      };
    }

    // 3. Create scheduled follow-up task if next_contact_date is provided
    let createdTask = null;
    if (next_contact_date) {
      try {
        createdTask = await TasksRepository.create({
          lead_id: cleanId,
          assigned_user_id: lead.responsible_user_id || actorUser?.id || 1,
          created_by: actorUser?.id || 1,
          type: 'CALL',
          priority: priority === 'HIGH' ? 'HIGH' : priority === 'LOW' ? 'LOW' : 'NORMAL',
          title: `Подбор: Контакт по кв. №${unit.unit_number}`,
          description: comment ? `Интерес: ${comment}` : `Клиент заинтересован в кв. №${unit.unit_number} (${unit.rooms}-комн., ${unit.area_m2_x100 / 100} м²)`,
          client_name: lead.full_name,
          phone: lead.phone,
          project_name: unit.floors?.sections?.buildings?.projects?.name || 'TOZON PLAZA',
          unit_number: String(unit.unit_number),
          due_date: next_contact_date,
          status: 'OPEN'
        });
      } catch (taskErr) {
        console.warn('Failed to auto-create contact task for unit interest:', taskErr.message);
      }
    }

    const areaM2 = unit.area_m2_x100 ? unit.area_m2_x100 / 100 : 0;
    const pricePerM2 = unit.price_per_m2_minor ? Math.round(unit.price_per_m2_minor / 100) : 0;
    const totalPrice = unit.manual_total_price_minor
      ? Math.round(unit.manual_total_price_minor / 100)
      : Math.round(areaM2 * pricePerM2);

    return {
      interest: {
        ...interestRecord,
        unit: {
          id: unit.id,
          unit_number: unit.unit_number,
          status: unit.status,
          rooms: unit.rooms,
          areaM2,
          pricePerM2,
          totalPrice,
          floor_number: unit.floors?.floor_number,
          building_name: unit.floors?.sections?.buildings?.name || 'Блок Б',
          project_name: unit.floors?.sections?.buildings?.projects?.name || 'TOZON PLAZA',
          plan_image_url: unit.layout_types?.image_path || null,
          layout_name: unit.layout_types?.name || null
        }
      },
      task: createdTask
    };
  }

  /**
   * Removes unit interest
   */
  static async removeInterestedUnit(leadId, unitId, actorUser) {
    const cleanId = parseRequiredBigInt(leadId, 'leadId');
    const cleanUnitId = parseRequiredBigInt(unitId, 'unitId');
    const db = getSecureDB();

    try {
      await db
        .from('lead_interested_units')
        .delete()
        .eq('lead_id', cleanId)
        .eq('unit_id', cleanUnitId);
    } catch {
      // Fallback
    }

    await this.addNote(cleanId, actorUser?.id || 1, `[UNIT_INTEREST_DELETED] ${JSON.stringify({ unit_id: cleanUnitId, deleted_at: new Date().toISOString() })}`);
    return true;
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
    const db = getSecureDB();
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

    let rawLeads = [];
    try {
      const { data, error } = await query;
      if (error) {
        console.error('[LeadsRepository.getSlaControlData] DB error:', error.code, error.message);
        throw error;
      }
      rawLeads = data || [];
    } catch (err) {
      console.error('[LeadsRepository.getSlaControlData] Query failed:', err.message);
      return {
        state: 'DATA_UNAVAILABLE',
        isAvailable: false,
        message: 'Данные контроля обработки лидов временно недоступны',
        summary: {
          totalActive: 0,
          unassignedCount: 0,
          contactWarningCount: 0,
          contactOverdueCount: 0,
          stagnantCount: 0,
          overdueTasksCount: 0,
          onTrackCount: 0,
          attentionRequiredCount: 0
        },
        leads: [],
        pagination: { total: 0, page: 1, limit: 50, totalPages: 1 }
      };
    }

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
      state: 'SUCCESS',
      isAvailable: true,
      summary,
      leads: paginatedLeads,
      pagination: { total, page, limit, totalPages }
    };
  }
}
