import { getServiceDB, getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

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

function logTechnical(level, payload) {
  // Technical IDs only: never log tokens, audio, or customer message text
  const safe = {
    ts: new Date().toISOString(),
    ...payload
  };
  if (level === 'warn') console.warn('[outbox-worker]', safe);
  else console.info('[outbox-worker]', safe);
}

async function loadAuthoritativeLead(db, leadId) {
  const { data, error } = await db
    .from('leads')
    .select('id, full_name, status, stage, version, responsible_user_id, interested_project_id, archived_at')
    .eq('id', Number(leadId))
    .maybeSingle();
  if (error) throw new Error(`Lead lookup failed: ${error.message}`);
  return data || null;
}

async function checkUserActiveAndProjectAccess(db, userId, projectId) {
  if (!userId) return { eligible: false, reason: 'NO_USER' };
  const { data: user, error: userErr } = await db
    .from('users')
    .select('id, name, role, is_active, all_projects_access')
    .eq('id', Number(userId))
    .maybeSingle();
  if (userErr) throw new Error(`User lookup failed: ${userErr.message}`);
  if (!user || Number(user.is_active) !== 1) {
    return { eligible: false, reason: 'USER_INACTIVE' };
  }
  if (user.all_projects_access === true) {
    return { eligible: true, user };
  }
  if (projectId === null || projectId === undefined) {
    return { eligible: false, reason: 'PROJECT_ACCESS_DENIED' };
  }
  const { data: accessRows, error: accessErr } = await db
    .from('user_project_access')
    .select('project_id')
    .eq('user_id', Number(userId))
    .eq('project_id', Number(projectId))
    .eq('can_view', true);
  if (accessErr) throw new Error(`Project access lookup failed: ${accessErr.message}`);
  if (!accessRows || accessRows.length === 0) {
    return { eligible: false, reason: 'PROJECT_ACCESS_DENIED' };
  }
  return { eligible: true, user };
}

async function insertIdempotentNotification(db, {
  userId,
  eventType,
  title,
  message,
  entityType = 'lead',
  entityId,
  actionUrl,
  dedupeKey,
  metadata = {}
}) {
  const { error } = await db
    .from('user_notifications')
    .upsert(
      [{
        user_id: Number(userId),
        event_type: eventType,
        type: eventType,
        title,
        message,
        entity_type: entityType,
        entity_id: Number(entityId),
        action_url: actionUrl,
        dedupe_key: dedupeKey,
        metadata
      }],
      { onConflict: 'dedupe_key', ignoreDuplicates: true }
    );
  if (error) throw new Error(`Notification insert failed: ${error.message}`);
}

async function insertIdempotentTask(db, {
  leadId,
  assignedUserId,
  createdBy,
  type = 'CALL',
  priority = 'NORMAL',
  title,
  description,
  dueAt,
  ruleKey,
  eventRef
}) {
  const { data: existing, error: selErr } = await db
    .from('tasks')
    .select('id')
    .eq('event_ref', eventRef)
    .eq('rule_key', ruleKey)
    .maybeSingle();
  if (selErr) throw new Error(`Task idempotency lookup failed: ${selErr.message}`);
  if (existing) return existing;

  const { data, error } = await db
    .from('tasks')
    .insert([{
      lead_id: Number(leadId),
      assigned_user_id: assignedUserId ? Number(assignedUserId) : null,
      created_by: createdBy ? Number(createdBy) : null,
      type,
      priority,
      title,
      description,
      due_at: dueAt || new Date(Date.now() + 3600000).toISOString(),
      status: 'OPEN',
      rule_key: ruleKey,
      event_ref: eventRef,
      idempotency_key: `${eventRef}:${ruleKey}`
    }])
    .select('id')
    .single();

  if (error) {
    // Handle concurrent unique constraint (23505) idempotently
    if (String(error.code) === '23505') {
      const { data: dup } = await db
        .from('tasks')
        .select('id')
        .eq('event_ref', eventRef)
        .eq('rule_key', ruleKey)
        .maybeSingle();
      if (dup) return dup;
    }
    throw new Error(`Task insert failed: ${error.message}`);
  }
  return data;
}

async function applyEnabledAutomationRules(db, event, lead, injectFault = null) {
  const { data: rules, error } = await db
    .from('crm_automation_rules')
    .select('*')
    .eq('event_type', event.event_type)
    .eq('is_enabled', true);
  if (error) throw new Error(`Automation rules lookup failed: ${error.message}`);

  for (const rule of (rules || [])) {
    if (rule.project_id && Number(rule.project_id) !== Number(lead.interested_project_id)) {
      continue;
    }
    const { data: existingExec } = await db
      .from('crm_automation_executions')
      .select('id')
      .eq('rule_id', rule.id)
      .eq('event_key', event.idempotency_key)
      .maybeSingle();
    if (existingExec) continue;

    // Only safe internal DB actions (CREATE_TASK, IN_APP_NOTIFICATION) are allowed in R08
    if (rule.action_type === 'CREATE_TASK' && lead.responsible_user_id) {
      const access = await checkUserActiveAndProjectAccess(db, lead.responsible_user_id, lead.interested_project_id);
      if (access.eligible) {
        await insertIdempotentTask(db, {
          leadId: lead.id,
          assignedUserId: lead.responsible_user_id,
          createdBy: event.payload_json?.actor_user_id || lead.responsible_user_id,
          type: rule.action_params_json?.task_type || 'CALL',
          priority: rule.action_params_json?.priority || 'NORMAL',
          title: rule.action_params_json?.title || rule.name,
          description: rule.action_params_json?.description || `Автоматическая задача по правилу: ${rule.name}`,
          dueAt: rule.action_params_json?.due_at || null,
          ruleKey: `RULE_${rule.id}`,
          eventRef: event.idempotency_key
        });
      }
    }

    if (injectFault === 'AFTER_EFFECT_BEFORE_DONE') {
      throw new Error('Injected crash after side effect before DONE');
    }

    await db
      .from('crm_automation_executions')
      .upsert(
        [{ rule_id: rule.id, event_key: event.idempotency_key, lead_id: lead.id, status: 'EXECUTED' }],
        { onConflict: 'rule_id,event_key', ignoreDuplicates: true }
      );
  }
}

export class OutboxWorkerService {
  static async processClaimedEvent(db, event, { injectFault = null } = {}) {
    if (!SUPPORTED_OUTBOX_EVENTS.has(event.event_type)) {
      throw new OutboxUnknownEventError(event.event_type);
    }

    const payload = event.payload_json || {};
    const leadId = Number(payload.lead_id || event.aggregate_id);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      throw new OutboxPermanentError('INVALID_PAYLOAD', 'Отсутствует корректный lead_id в payload_json');
    }

    const lead = await loadAuthoritativeLead(db, leadId);
    if (!lead || lead.archived_at) {
      return { skipped: true, reason: lead ? 'LEAD_ARCHIVED' : 'LEAD_NOT_FOUND' };
    }

    const currentStage = lead.stage || lead.status || 'NEW';

    if (event.event_type === 'LEAD_LOST') {
      if (currentStage !== 'LOST') {
        return { skipped: true, reason: 'LEAD_REOPENED' };
      }
      await applyEnabledAutomationRules(db, event, lead, injectFault);
      return { handled: true };
    }

    if (currentStage === 'LOST' || currentStage === 'SIGNED') {
      return { skipped: true, reason: 'LEAD_ALREADY_CLOSED' };
    }

    if (event.event_type === 'LEAD_ASSIGNED') {
      const targetUserId = Number(payload.to_user_id);
      if (!targetUserId || Number(lead.responsible_user_id) !== targetUserId) {
        return { skipped: true, reason: 'LEAD_REASSIGNED_ELSEWHERE' };
      }
      const access = await checkUserActiveAndProjectAccess(db, targetUserId, lead.interested_project_id);
      if (!access.eligible) {
        return { skipped: true, reason: access.reason };
      }
      await insertIdempotentNotification(db, {
        userId: targetUserId,
        eventType: 'LEAD_ASSIGNED',
        title: `Назначен лид #${lead.id}`,
        message: `Вам назначен лид ${lead.full_name || `#${lead.id}`}`,
        entityId: lead.id,
        actionUrl: `/leads?leadId=${lead.id}`,
        dedupeKey: `outbox:${event.idempotency_key}:assigned:${targetUserId}`,
        metadata: { lead_id: lead.id, event_id: event.id }
      });
      if (injectFault === 'AFTER_EFFECT_BEFORE_DONE') {
        throw new Error('Injected crash after notification before DONE');
      }
      await applyEnabledAutomationRules(db, event, lead, injectFault);
      return { handled: true };
    }

    if (event.event_type === 'LEAD_STAGE_CHANGED') {
      const toStage = String(payload.to_stage || '').toUpperCase();
      if (toStage && toStage !== currentStage) {
        return { skipped: true, reason: 'STAGE_ALREADY_ADVANCED' };
      }
      if (lead.responsible_user_id) {
        const access = await checkUserActiveAndProjectAccess(db, lead.responsible_user_id, lead.interested_project_id);
        if (access.eligible) {
          if (toStage === 'MEETING_SCHEDULED' && payload.meeting_at) {
            await insertIdempotentTask(db, {
              leadId: lead.id,
              assignedUserId: lead.responsible_user_id,
              createdBy: payload.actor_user_id || lead.responsible_user_id,
              type: 'MEETING',
              priority: 'HIGH',
              title: `Встреча с клиентом #${lead.id}`,
              description: `Запланированная встреча по лиду #${lead.id}`,
              dueAt: payload.meeting_at,
              ruleKey: 'STAGE_MEETING_FOLLOWUP',
              eventRef: event.idempotency_key
            });
          } else if (toStage === 'SHOWING_DONE' && payload.showing_at) {
            await insertIdempotentTask(db, {
              leadId: lead.id,
              assignedUserId: lead.responsible_user_id,
              createdBy: payload.actor_user_id || lead.responsible_user_id,
              type: 'CALL',
              priority: 'NORMAL',
              title: `Итоги показа по лиду #${lead.id}`,
              description: `Связаться с клиентом после показа (объект #${payload.showing_project_id || lead.interested_project_id || '—'})`,
              dueAt: payload.showing_at,
              ruleKey: 'STAGE_SHOWING_FOLLOWUP',
              eventRef: event.idempotency_key
            });
          }
          await insertIdempotentNotification(db, {
            userId: lead.responsible_user_id,
            eventType: 'LEAD_STAGE_CHANGED',
            title: `Этап лида #${lead.id}: ${toStage || currentStage}`,
            message: `Лид ${lead.full_name || `#${lead.id}`} переведён на этап ${toStage || currentStage}`,
            entityId: lead.id,
            actionUrl: `/leads?leadId=${lead.id}`,
            dedupeKey: `outbox:${event.idempotency_key}:stage:${lead.responsible_user_id}`,
            metadata: { lead_id: lead.id, to_stage: toStage, event_id: event.id }
          });
        }
      }
      if (injectFault === 'AFTER_EFFECT_BEFORE_DONE') {
        throw new Error('Injected crash after side effect before DONE');
      }
      await applyEnabledAutomationRules(db, event, lead, injectFault);
      return { handled: true };
    }

    if (event.event_type === 'LEAD_CREATED' || event.event_type === 'LEAD_IMPORTED' || event.event_type === 'COMMUNICATION_LOGGED') {
      if (lead.responsible_user_id) {
        const access = await checkUserActiveAndProjectAccess(db, lead.responsible_user_id, lead.interested_project_id);
        if (access.eligible && (event.event_type === 'LEAD_CREATED' || event.event_type === 'LEAD_IMPORTED')) {
          await insertIdempotentNotification(db, {
            userId: lead.responsible_user_id,
            eventType: event.event_type,
            title: `Новый лид #${lead.id}`,
            message: `Поступил лид ${lead.full_name || `#${lead.id}`}`,
            entityId: lead.id,
            actionUrl: `/leads?leadId=${lead.id}`,
            dedupeKey: `outbox:${event.idempotency_key}:created:${lead.responsible_user_id}`,
            metadata: { lead_id: lead.id, event_id: event.id }
          });
        }
      }
      if (injectFault === 'AFTER_EFFECT_BEFORE_DONE') {
        throw new Error('Injected crash after side effect before DONE');
      }
      await applyEnabledAutomationRules(db, event, lead, injectFault);
      return { handled: true };
    }

    return { handled: true };
  }

  static async runOnce({
    workerId = `worker_${process.pid}`,
    batchSize = 25,
    leaseSeconds = 60,
    ignoreEnabled = false,
    injectFault = null
  } = {}) {
    const db = getSafeDB();
    const { data: claimed, error: claimErr } = await db.rpc('fn_claim_outbox_batch', {
      p_worker_id: workerId,
      p_batch_size: batchSize,
      p_lease_seconds: leaseSeconds,
      p_ignore_enabled: ignoreEnabled
    });

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
        await this.processClaimedEvent(db, event, { injectFault });

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
    await db
      .from('crm_outbox_settings')
      .update({
        last_run_at: nowIso,
        ...(results.retried === 0 && results.quarantined === 0 ? { last_success_at: nowIso, last_error: null } : {}),
        updated_at: nowIso
      })
      .eq('id', 1);

    return results;
  }

  static async getDiagnostics() {
    const db = getSafeDB();
    const [{ data: settings }, { data: rows, error }] = await Promise.all([
      db.from('crm_outbox_settings').select('*').eq('id', 1).maybeSingle(),
      db.from('crm_event_outbox').select('id, event_type, aggregate_id, status, attempts, max_attempts, next_retry_at, error_kind, quarantine_reason, created_at, processed_at').order('created_at', { ascending: true }).limit(1000)
    ]);
    if (error) throw new AppError('Не удалось получить диагностику outbox', 503);

    const list = rows || [];
    const pending = list.filter((r) => r.status === 'PENDING');
    const failed = list.filter((r) => r.status === 'FAILED');
    const processing = list.filter((r) => r.status === 'PROCESSING');
    const quarantined = list.filter((r) => r.status === 'QUARANTINED');
    const dueCandidates = [...pending, ...failed];
    const oldestMs = dueCandidates.length ? Math.min(...dueCandidates.map((r) => Date.parse(r.created_at))) : null;

    return {
      queueSize: pending.length + failed.length,
      pendingCount: pending.length,
      failedCount: failed.length,
      processingCount: processing.length,
      quarantinedCount: quarantined.length,
      oldestPendingAgeSeconds: oldestMs ? Math.max(0, Math.floor((Date.now() - oldestMs) / 1000)) : 0,
      settings: settings || null,
      recentQuarantined: quarantined.slice(-20)
    };
  }

  static async previewCutoff({ cutoffAt }) {
    const db = getSafeDB();
    const { data: rows, error } = await db
      .from('crm_event_outbox')
      .select('id, status, created_at')
      .in('status', ['PENDING', 'FAILED']);
    if (error) throw new AppError('Не удалось выполнить предпросмотр cutoff', 503);
    const cutoffMs = Date.parse(cutoffAt);
    if (!Number.isFinite(cutoffMs)) throw new AppError('Некорректная дата cutoffAt', 400);

    const eligible = (rows || []).filter((r) => Date.parse(r.created_at) >= cutoffMs);
    const skippedHistorical = (rows || []).filter((r) => Date.parse(r.created_at) < cutoffMs);
    return {
      cutoffAt: new Date(cutoffMs).toISOString(),
      eligibleCount: eligible.length,
      skippedHistoricalCount: skippedHistorical.length
    };
  }

  static async updateSettings({ isEnabled, cutoffAt, batchSize, leaseSeconds, actorUserId }) {
    const db = getSafeDB();
    const patch = {
      updated_by: actorUserId ? Number(actorUserId) : null,
      updated_at: new Date().toISOString()
    };
    if (typeof isEnabled === 'boolean') patch.is_enabled = isEnabled;
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
