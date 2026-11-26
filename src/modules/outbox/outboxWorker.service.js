import { getServiceDB, getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { calculateSalesSlaDeadline, normalizeToSalesWorkingWindow } from '../leads/leadSla.service.js';

const getSafeDB = () => {
  try { return getServiceDB(); } catch { return getDB(); }
};

export const SUPPORTED_OUTBOX_EVENTS = new Set([
  'LEAD_CREATED',
  'LEAD_IMPORTED',
  'LEAD_ASSIGNED',
  'LEAD_STAGE_CHANGED',
  'LEAD_LOST',
  'COMMUNICATION_LOGGED'
]);

const SUPPORTED_RULE_ACTIONS = new Set(['CREATE_TASK', 'IN_APP_NOTIFICATION']);

class OutboxPermanentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.kind = 'PERMANENT';
  }
}

class OutboxUnknownEventError extends Error {
  constructor(eventType) {
    super(`Неизвестный тип события outbox: ${eventType}`);
    this.code = 'UNKNOWN_EVENT';
    this.kind = 'UNKNOWN_EVENT';
  }
}

class OutboxLeaseLostError extends Error {
  constructor() {
    super('LEASE_LOST');
    this.code = 'LEASE_LOST';
  }
}

function logTechnical(level, payload) {
  const safe = { ts: new Date().toISOString(), ...payload };
  if (level === 'warn') console.warn('[outbox-worker]', safe);
  else console.info('[outbox-worker]', safe);
}

function evaluateRuleConditions(rule, event, lead) {
  if (rule.project_id && Number(rule.project_id) !== Number(lead.interested_project_id)) {
    return { matched: false, reason: 'PROJECT_MISMATCH' };
  }
  const leadSource = String(lead.source_code || lead.source || '').toUpperCase();
  if (rule.source_code && String(rule.source_code).toUpperCase() !== leadSource) {
    return { matched: false, reason: 'SOURCE_MISMATCH' };
  }
  const cond = rule.conditions_json || {};
  const currentStage = String(lead.stage || lead.status || 'NEW').toUpperCase();
  if (cond.stage && String(cond.stage).toUpperCase() !== currentStage) {
    return { matched: false, reason: 'STAGE_MISMATCH' };
  }
  if (cond.min_budget_minor !== undefined && Number(lead.budget_max_minor || 0) < Number(cond.min_budget_minor)) {
    return { matched: false, reason: 'BUDGET_BELOW_MIN' };
  }
  const payload = event.payload_json || {};
  if (cond.channel && String(cond.channel).toUpperCase() !== String(payload.channel || '').toUpperCase()) {
    return { matched: false, reason: 'CHANNEL_MISMATCH' };
  }
  if (cond.outcome && String(cond.outcome).toUpperCase() !== String(payload.outcome || '').toUpperCase()) {
    return { matched: false, reason: 'OUTCOME_MISMATCH' };
  }
  if (cond.comm_event_type && String(cond.comm_event_type).toUpperCase() !== String(payload.comm_event_type || '').toUpperCase()) {
    return { matched: false, reason: 'COMM_EVENT_TYPE_MISMATCH' };
  }
  return { matched: true };
}

function buildRuleActionEffects(rule, event, lead, tasks, notifications) {
  if (!SUPPORTED_RULE_ACTIONS.has(rule.action_type)) {
    throw new OutboxPermanentError('UNSUPPORTED_RULE_ACTION', `Неподдержанное действие правила: ${rule.action_type}`);
  }
  if (rule.action_type === 'CREATE_TASK' && lead.responsible_user_id) {
    const minutes = Number(rule.action_params_json?.sla_minutes || 60);
    const dueAtDate = rule.action_params_json?.due_at
      ? normalizeToSalesWorkingWindow(new Date(rule.action_params_json.due_at))
      : calculateSalesSlaDeadline(new Date(), minutes);
    const dueAt = (dueAtDate || calculateSalesSlaDeadline(new Date(), 60)).toISOString();
    tasks.push({
      assigned_user_id: lead.responsible_user_id,
      created_by: event.payload_json?.actor_user_id || lead.responsible_user_id,
      type: rule.action_params_json?.task_type || 'CALL',
      priority: rule.action_params_json?.priority || 'NORMAL',
      title: rule.action_params_json?.title || rule.name,
      description: rule.action_params_json?.description || `Автоматическая задача по правилу: ${rule.name}`,
      due_at: dueAt,
      due_date: dueAt.split('T')[0],
      timezone: 'Asia/Dushanbe',
      rule_key: `RULE_${rule.id}`,
      event_ref: event.idempotency_key,
      idempotency_key: `${event.idempotency_key}:RULE_${rule.id}`
    });
  } else if (rule.action_type === 'IN_APP_NOTIFICATION' && lead.responsible_user_id) {
    notifications.push({
      user_id: lead.responsible_user_id,
      event_type: event.event_type,
      title: rule.action_params_json?.title || rule.name,
      message: rule.action_params_json?.message || `Сработало правило «${rule.name}» по лиду #${lead.id}`,
      action_url: `/leads?leadId=${lead.id}`,
      dedupe_key: `outbox:${event.idempotency_key}:rule:${rule.id}:${lead.responsible_user_id}`,
      metadata: { lead_id: lead.id, rule_id: rule.id, event_id: event.id }
    });
  }
}

export class OutboxWorkerService {
  static async processClaimedEvent(db, event, settings = {}, { injectFault = null } = {}) {
    if (!SUPPORTED_OUTBOX_EVENTS.has(event.event_type)) {
      throw new OutboxUnknownEventError(event.event_type);
    }

    const payload = event.payload_json || {};
    const leadId = Number(payload.lead_id || event.aggregate_id);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      throw new OutboxPermanentError('INVALID_PAYLOAD', 'Отсутствует корректный lead_id в payload_json');
    }

    const { data: lead, error: leadErr } = await db
      .from('leads')
      .select('id, full_name, phone, source, source_code, status, stage, version, responsible_user_id, interested_project_id, budget_max_minor, first_contact_at, assigned_at, created_at, is_historical_import, archived_at')
      .eq('id', leadId)
      .maybeSingle();
    if (leadErr) throw new Error(`Lead lookup failed: ${leadErr.message}`);
    if (!lead || lead.archived_at) {
      return { skipped: true, reason: lead ? 'LEAD_ARCHIVED' : 'LEAD_NOT_FOUND' };
    }

    // Historical import policy: suppress ONLY the historical import event itself, NOT future live events on the contact/lead
    const isHistoricalEvent = event.event_type === 'LEAD_IMPORTED' || payload.is_historical_import === true;
    if (isHistoricalEvent && !settings?.process_historical_import) {
      return { skipped: true, reason: 'HISTORICAL_IMPORT_SKIPPED' };
    }

    const tasks = [];
    const notifications = [];
    const ruleExecutions = [];
    let expectedAssignedUserId = lead.responsible_user_id ? Number(lead.responsible_user_id) : null;
    let requireOpen = true;

    const parseSafeDate = (val, fallback) => {
      const ms = val ? Date.parse(val) : NaN;
      return Number.isFinite(ms) ? new Date(ms) : fallback;
    };

    if (event.event_type === 'LEAD_LOST') {
      requireOpen = false;
      if ((lead.stage || lead.status) !== 'LOST') {
        return { skipped: true, reason: 'LEAD_REOPENED' };
      }
    } else if (event.event_type === 'LEAD_ASSIGNED') {
      const targetUserId = Number(payload.to_user_id);
      if (!targetUserId) return { skipped: true, reason: 'NO_TARGET_USER' };
      expectedAssignedUserId = targetUserId;

      if (!lead.first_contact_at) {
        const factTime = parseSafeDate(lead.assigned_at || payload.assigned_at || event.created_at, new Date());
        const deadline = calculateSalesSlaDeadline(factTime, 15);
        const dueAt = (deadline || new Date(factTime.getTime() + 15 * 60000)).toISOString();
        tasks.push({
          assigned_user_id: targetUserId,
          created_by: payload.actor_user_id || targetUserId,
          type: 'CALL',
          priority: 'HIGH',
          title: `Первичный контакт (15 мин SLA): ${lead.full_name || `#${lead.id}`}`,
          description: `Связаться с клиентом в течение 15 минут. Регламент: Asia/Dushanbe.`,
          due_at: dueAt,
          due_date: dueAt.split('T')[0],
          timezone: 'Asia/Dushanbe',
          rule_key: 'PRIMARY_FIRST_CONTACT',
          event_ref: `lead_primary_${lead.id}`,
          idempotency_key: `lead_primary_${lead.id}`
        });
      }

      notifications.push({
        user_id: targetUserId,
        event_type: 'LEAD_ASSIGNED',
        title: `Назначен лид #${lead.id}`,
        message: `Вам назначен лид ${lead.full_name || `#${lead.id}`}`,
        action_url: `/leads?leadId=${lead.id}`,
        dedupe_key: `outbox:${event.idempotency_key}:assigned:${targetUserId}`,
        metadata: { lead_id: lead.id, event_id: event.id }
      });
    } else if (event.event_type === 'LEAD_CREATED' || event.event_type === 'LEAD_IMPORTED') {
      if (lead.responsible_user_id) {
        if (!lead.first_contact_at) {
          const factTime = parseSafeDate(lead.created_at || event.created_at, new Date());
          const deadline = calculateSalesSlaDeadline(factTime, 15);
          const dueAt = (deadline || new Date(factTime.getTime() + 15 * 60000)).toISOString();
          tasks.push({
            assigned_user_id: lead.responsible_user_id,
            created_by: payload.actor_user_id || lead.responsible_user_id,
            type: 'CALL',
            priority: 'HIGH',
            title: `Первичный контакт (15 мин SLA): ${lead.full_name || `#${lead.id}`}`,
            description: `Связаться с новым клиентом в течение 15 минут. Регламент: Asia/Dushanbe.`,
            due_at: dueAt,
            due_date: dueAt.split('T')[0],
            timezone: 'Asia/Dushanbe',
            rule_key: 'PRIMARY_FIRST_CONTACT',
            event_ref: `lead_primary_${lead.id}`,
            idempotency_key: `lead_primary_${lead.id}`
          });
        }
        notifications.push({
          user_id: lead.responsible_user_id,
          event_type: event.event_type,
          title: `Новый лид #${lead.id}`,
          message: `Поступил лид ${lead.full_name || `#${lead.id}`}`,
          action_url: `/leads?leadId=${lead.id}`,
          dedupe_key: `outbox:${event.idempotency_key}:created:${lead.responsible_user_id}`,
          metadata: { lead_id: lead.id, event_id: event.id }
        });
      }
    } else if (event.event_type === 'LEAD_STAGE_CHANGED') {
      const toStage = String(payload.to_stage || '').toUpperCase();
      if (toStage && toStage !== String(lead.stage || lead.status || '').toUpperCase()) {
        return { skipped: true, reason: 'STAGE_ALREADY_ADVANCED' };
      }
      if (lead.responsible_user_id) {
        if (toStage === 'MEETING_SCHEDULED' && payload.meeting_at) {
          // Preserve exact agreed meeting timestamp without silent shifting
          const dueAt = new Date(payload.meeting_at).toISOString();
          tasks.push({
            assigned_user_id: lead.responsible_user_id,
            created_by: payload.actor_user_id || lead.responsible_user_id,
            type: 'MEETING',
            priority: 'HIGH',
            title: `Встреча с клиентом #${lead.id}`,
            description: `Запланированная встреча по лиду #${lead.id}`,
            due_at: dueAt,
            due_date: dueAt.split('T')[0],
            timezone: 'Asia/Dushanbe',
            rule_key: 'STAGE_MEETING_FOLLOWUP',
            event_ref: event.idempotency_key,
            idempotency_key: `${event.idempotency_key}:STAGE_MEETING_FOLLOWUP`
          });
        } else if (toStage === 'SHOWING_DONE' && payload.showing_at) {
          const factShowing = parseSafeDate(payload.showing_at, new Date());
          const dueAt = calculateSalesSlaDeadline(factShowing, 60).toISOString();
          tasks.push({
            assigned_user_id: lead.responsible_user_id,
            created_by: payload.actor_user_id || lead.responsible_user_id,
            type: 'CALL',
            priority: 'NORMAL',
            title: `Итоги показа по лиду #${lead.id}`,
            description: `Связаться с клиентом после показа (объект #${payload.showing_project_id || lead.interested_project_id || '—'})`,
            due_at: dueAt,
            due_date: dueAt.split('T')[0],
            timezone: 'Asia/Dushanbe',
            rule_key: 'STAGE_SHOWING_FOLLOWUP',
            event_ref: event.idempotency_key,
            idempotency_key: `${event.idempotency_key}:STAGE_SHOWING_FOLLOWUP`
          });
        }
        notifications.push({
          user_id: lead.responsible_user_id,
          event_type: 'LEAD_STAGE_CHANGED',
          title: `Этап лида #${lead.id}: ${toStage || lead.stage}`,
          message: `Лид ${lead.full_name || `#${lead.id}`} переведён на этап ${toStage || lead.stage}`,
          action_url: `/leads?leadId=${lead.id}`,
          dedupe_key: `outbox:${event.idempotency_key}:stage:${lead.responsible_user_id}`,
          metadata: { lead_id: lead.id, to_stage: toStage, event_id: event.id }
        });
      }
    } else if (event.event_type === 'COMMUNICATION_LOGGED' && lead.responsible_user_id) {
      const commType = String(payload.comm_event_type || payload.outcome || '').toUpperCase();
      if (commType === 'NO_ANSWER' || commType === 'BUSY') {
        const slaMins = commType === 'BUSY' ? 60 : 120;
        const factTime = parseSafeDate(event.created_at, new Date());
        const dueAt = calculateSalesSlaDeadline(factTime, slaMins).toISOString();
        tasks.push({
          assigned_user_id: lead.responsible_user_id,
          created_by: payload.actor_user_id || lead.responsible_user_id,
          type: 'CALL',
          priority: 'NORMAL',
          title: commType === 'BUSY' ? `Перезвонить (занято): #${lead.id}` : `Повторный звонок (недозвон): #${lead.id}`,
          description: `Автоматический перезвон по регламенту рабочего времени (Asia/Dushanbe)`,
          due_at: dueAt,
          due_date: dueAt.split('T')[0],
          timezone: 'Asia/Dushanbe',
          rule_key: `COMM_${commType}_FOLLOWUP`,
          event_ref: event.idempotency_key,
          idempotency_key: `${event.idempotency_key}:COMM_${commType}_FOLLOWUP`
        });
      } else if (payload.callback_at) {
        // Preserve exact agreed callback timestamp without silent shifting
        const dueAt = new Date(payload.callback_at).toISOString();
        tasks.push({
          assigned_user_id: lead.responsible_user_id,
          created_by: payload.actor_user_id || lead.responsible_user_id,
          type: 'CALL',
          priority: 'HIGH',
          title: `Согласованный перезвон: #${lead.id}`,
          description: `Согласованный перезвон клиенту #${lead.id}`,
          due_at: dueAt,
          due_date: dueAt.split('T')[0],
          timezone: 'Asia/Dushanbe',
          rule_key: 'COMM_CALLBACK',
          event_ref: event.idempotency_key,
          idempotency_key: `${event.idempotency_key}:COMM_CALLBACK`
        });
      }
    }

    // Evaluate enabled crm_automation_rules (never mark EXECUTED if skipped/unsupported!)
    const { data: rules, error: rulesErr } = await db
      .from('crm_automation_rules')
      .select('*')
      .eq('event_type', event.event_type)
      .eq('is_enabled', true);
    if (rulesErr) throw new Error(`Automation rules lookup failed: ${rulesErr.message}`);

    for (const rule of (rules || [])) {
      const check = evaluateRuleConditions(rule, event, lead);
      if (!check.matched) {
        ruleExecutions.push({
          rule_id: rule.id,
          event_key: event.idempotency_key,
          status: 'SKIPPED',
          error_message: check.reason
        });
        continue;
      }
      // Unsupported action throws OutboxPermanentError -> NEVER recorded as EXECUTED
      buildRuleActionEffects(rule, event, lead, tasks, notifications);
      ruleExecutions.push({
        rule_id: rule.id,
        event_key: event.idempotency_key,
        status: 'EXECUTED',
        error_message: null
      });
    }

    if (injectFault === 'EXPIRE_LEASE_BEFORE_APPLY') {
      await db.rpc('fn_test_expire_lease_helper', { p_event_id: event.id }).catch(() => {});
    }
    if (injectFault === 'REASSIGN_BEFORE_APPLY') {
      await db.rpc('fn_test_reassign_lead_helper', { p_lead_id: lead.id }).catch(() => {});
    }

    if (tasks.length === 0 && notifications.length === 0 && ruleExecutions.length === 0) {
      return { handled: true, empty: true };
    }

    const { data: applyRes, error: applyErr } = await db.rpc('fn_apply_outbox_effect', {
      p_event_id: event.id,
      p_lease_token: event.lease_token,
      p_expected_lead_id: lead.id,
      p_expected_assigned_user_id: expectedAssignedUserId,
      p_require_open: requireOpen,
      p_tasks: tasks,
      p_notifications: notifications,
      p_rule_executions: ruleExecutions
    });

    if (applyErr) {
      throw new Error(`Effect apply failed: ${applyErr.message}`);
    }
    if (applyRes?.ok === false && applyRes?.code === 'LEASE_LOST') {
      throw new OutboxLeaseLostError();
    }

    if (injectFault === 'AFTER_EFFECT_BEFORE_DONE') {
      throw new Error('Injected crash after effect before DONE');
    }

    return applyRes;
  }

  static async runOnce({
    workerId = `worker_${process.pid}`,
    batchSize = 25,
    leaseSeconds = 60,
    ignoreEnabled = false,
    actorUserId = null,
    injectFault = null
  } = {}) {
    if (ignoreEnabled) {
      logTechnical('info', { action: 'MANUAL_RUN_ONCE_OVERRIDE', actorUserId, workerId });
    }
    const db = getSafeDB();
    const [{ data: settings }, { data: claimed, error: claimErr }] = await Promise.all([
      db.from('crm_outbox_settings').select('*').eq('id', 1).maybeSingle(),
      db.rpc('fn_claim_outbox_batch', {
        p_worker_id: workerId,
        p_batch_size: batchSize,
        p_lease_seconds: leaseSeconds,
        p_ignore_enabled: ignoreEnabled
      })
    ]);

    if (claimErr) {
      throw new AppError(`Не удалось захватить партию outbox: ${claimErr.message}`, 503);
    }

    const events = Array.isArray(claimed) ? claimed : [];
    const results = {
      claimed: events.length,
      done: 0,
      retried: 0,
      quarantined: 0,
      leaseLost: 0
    };

    for (const event of events) {
      try {
        if (injectFault === 'CRASH_BEFORE_EFFECT') {
          throw new Error('Injected crash before effect');
        }
        await this.processClaimedEvent(db, event, settings || {}, { injectFault });

        const { data: ack, error: ackErr } = await db.rpc('fn_complete_outbox_event', {
          p_event_id: event.id,
          p_lease_token: event.lease_token,
          p_outcome: 'DONE',
          p_error_kind: null,
          p_error_message: null
        });
        if (ackErr || ack?.ok === false) {
          results.leaseLost += 1;
          logTechnical('warn', { eventId: event.id, eventType: event.event_type, code: ack?.code || 'ACK_FAILED' });
        } else {
          results.done += 1;
          logTechnical('info', { eventId: event.id, eventType: event.event_type, aggregateId: event.aggregate_id, outcome: 'DONE' });
        }
      } catch (err) {
        if (err instanceof OutboxLeaseLostError || err?.code === 'LEASE_LOST') {
          results.leaseLost += 1;
          logTechnical('warn', { eventId: event.id, eventType: event.event_type, code: 'LEASE_LOST' });
          continue;
        }
        const isUnknown = err instanceof OutboxUnknownEventError || err?.kind === 'UNKNOWN_EVENT';
        const isPermanent = err instanceof OutboxPermanentError || err?.kind === 'PERMANENT';
        const outcome = (isUnknown || isPermanent) ? 'QUARANTINE' : 'RETRY';
        const errorKind = isUnknown ? 'UNKNOWN_EVENT' : (isPermanent ? 'PERMANENT' : 'TRANSIENT');

        const { data: ack } = await db.rpc('fn_complete_outbox_event', {
          p_event_id: event.id,
          p_lease_token: event.lease_token,
          p_outcome: outcome,
          p_error_kind: errorKind,
          p_error_message: String(err?.message || 'WORKER_ERROR').slice(0, 500)
        });

        if (ack?.ok === false) {
          results.leaseLost += 1;
          logTechnical('warn', { eventId: event.id, eventType: event.event_type, code: ack.code || 'LEASE_LOST' });
        } else if (ack?.status === 'QUARANTINED') {
          results.quarantined += 1;
          logTechnical('warn', { eventId: event.id, eventType: event.event_type, outcome: 'QUARANTINED', errorKind });
        } else {
          results.retried += 1;
          logTechnical('warn', { eventId: event.id, eventType: event.event_type, outcome: 'RETRY', errorKind });
        }
      }
    }

    const nowIso = new Date().toISOString();
    const isFullSuccess = results.retried === 0 && results.quarantined === 0 && results.leaseLost === 0;
    await db
      .from('crm_outbox_settings')
      .update({
        last_run_at: nowIso,
        ...(isFullSuccess ? { last_success_at: nowIso, last_error: null } : {}),
        ...(results.leaseLost > 0 ? { last_error: 'LEASE_LOST' } : {}),
        updated_at: nowIso
      })
      .eq('id', 1);

    return results;
  }

  static async isOutboxWorkerActive() {
    if (process.env.OUTBOX_WORKER_ENABLED !== 'true') return false;
    try {
      const db = getSafeDB();
      const { data } = await db.from('crm_outbox_settings').select('is_enabled').eq('id', 1).maybeSingle();
      return Boolean(data?.is_enabled);
    } catch {
      return false;
    }
  }

  static async getDiagnostics() {
    const db = getSafeDB();
    const { data: diag, error } = await db.rpc('fn_outbox_diagnostics');
    if (error || !diag) throw new AppError('Не удалось получить диагностику outbox', 503);

    const envWorkerEnabled = process.env.OUTBOX_WORKER_ENABLED === 'true';
    const dbWorkerEnabled = Boolean(diag.settings?.is_enabled);
    const misconfiguredWarning = envWorkerEnabled !== dbWorkerEnabled
      ? (envWorkerEnabled
          ? 'OUTBOX_WORKER_ENABLED=true, но crm_outbox_settings.is_enabled=false: работает legacy-резерв'
          : 'crm_outbox_settings.is_enabled=true, но OUTBOX_WORKER_ENABLED!=true')
      : null;

    return {
      ...diag,
      envWorkerEnabled,
      dbWorkerEnabled,
      effectiveActive: envWorkerEnabled && dbWorkerEnabled,
      misconfiguredWarning
    };
  }

  static async previewCutoff({ cutoffAt }) {
    const cutoffMs = Date.parse(cutoffAt);
    if (!Number.isFinite(cutoffMs)) throw new AppError('Некорректная дата cutoffAt', 400);
    const db = getSafeDB();
    const { data, error } = await db.rpc('fn_outbox_preview_cutoff', {
      p_cutoff_at: new Date(cutoffMs).toISOString()
    });
    if (error || !data) throw new AppError('Не удалось выполнить предпросмотр cutoff', 503);
    return data;
  }

  static async updateSettings({ isEnabled, cutoffAt, batchSize, leaseSeconds, processHistoricalImport, actorUserId }) {
    const db = getSafeDB();
    const patch = {
      updated_by: actorUserId ? Number(actorUserId) : null,
      updated_at: new Date().toISOString()
    };
    if (typeof isEnabled === 'boolean') patch.is_enabled = isEnabled;
    if (typeof processHistoricalImport === 'boolean') patch.process_historical_import = processHistoricalImport;
    if (cutoffAt !== undefined) {
      const ms = Date.parse(cutoffAt);
      if (!Number.isFinite(ms)) throw new AppError('Некорректная дата cutoffAt', 400);
      patch.cutoff_at = new Date(ms).toISOString();
    }
    if (batchSize !== undefined) {
      const b = Number(batchSize);
      if (!Number.isInteger(b) || b < 1 || b > 100) throw new AppError('Недопустимый batchSize (1..100)', 400);
      patch.batch_size = b;
    }
    if (leaseSeconds !== undefined) {
      const l = Number(leaseSeconds);
      if (!Number.isInteger(l) || l < 5 || l > 600) throw new AppError('Недопустимый leaseSeconds (5..600)', 400);
      patch.lease_seconds = l;
    }

    const { data, error } = await db
      .from('crm_outbox_settings')
      .update(patch)
      .eq('id', 1)
      .select()
      .single();
    if (error) throw new AppError('Не удалось обновить настройки outbox', 503);
    return data;
  }

  static async replayQuarantined({ eventId, actorUserId }) {
    const db = getSafeDB();
    const id = Number(eventId);
    if (!Number.isInteger(id) || id <= 0) throw new AppError('Некорректный ID события', 400);

    const { data: existing, error: selErr } = await db
      .from('crm_event_outbox')
      .select('id, event_type, status')
      .eq('id', id)
      .maybeSingle();
    if (selErr) throw new AppError('Не удалось найти событие outbox', 503);
    if (!existing) throw new AppError('Событие outbox не найдено', 404);
    if (!['QUARANTINED', 'FAILED'].includes(existing.status)) {
      throw new AppError('Повтор доступен только для QUARANTINED или FAILED событий', 409);
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await db
      .from('crm_event_outbox')
      .update({
        status: 'PENDING',
        attempts: 0,
        next_retry_at: nowIso,
        last_error: null,
        error_kind: null,
        quarantine_reason: null,
        lease_token: null,
        lease_expires_at: null,
        locked_by: null,
        replayed_by: actorUserId ? Number(actorUserId) : null,
        replayed_at: nowIso
      })
      .eq('id', id)
      .select('id, event_type, status, replayed_by, replayed_at')
      .single();
    if (error) throw new AppError('Не удалось поставить событие на повтор', 503);
    logTechnical('info', { eventId: id, eventType: existing.event_type, action: 'MANUAL_REPLAY', actorUserId });
    return data;
  }
}
