import { getDB, getServiceDB } from '../../db/connection.js';
import { getBusinessDate } from '../../utils/businessTime.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const getSecureDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_SUFFIX_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function assertValidCalendarDate(dateStr) {
  if (typeof dateStr !== 'string' || !ISO_DATE_RE.test(dateStr)) {
    throw new AppError('Некорректная календарная дата due_date (ожидается YYYY-MM-DD)', 400);
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
    throw new AppError('Некорректная календарная дата due_date', 400);
  }
}

function assertValidDueAtWithTz(dueAtVal) {
  if (typeof dueAtVal !== 'string' || !TZ_SUFFIX_RE.test(dueAtVal.trim())) {
    throw new AppError('Поле due_at должно содержать однозначный часовой пояс (Z или ±HH:MM)', 400);
  }
  const ms = Date.parse(dueAtVal.trim());
  if (!Number.isFinite(ms)) {
    throw new AppError('Некорректный формат даты-времени due_at', 400);
  }
  return new Date(ms).toISOString();
}

export function normalizeTaskDueFields(input = {}, existingTask = null, { isCreate = false } = {}) {
  const hasDueDateOnly = input.due_date_only !== undefined;
  const hasDueAt = input.due_at !== undefined;
  const hasDueDate = input.due_date !== undefined;
  const hasTimezone = input.timezone !== undefined;

  if (!isCreate && !hasDueDateOnly && !hasDueAt && !hasDueDate && !hasTimezone) {
    return {};
  }

  if (hasDueDateOnly && typeof input.due_date_only !== 'boolean') {
    throw new AppError('Поле due_date_only должно быть boolean', 400);
  }
  if (hasDueDate && input.due_date !== null) {
    assertValidCalendarDate(input.due_date);
  }

  let normalizedInputDueAt;
  if (hasDueAt) {
    normalizedInputDueAt = input.due_at === null ? null : assertValidDueAtWithTz(input.due_at);
  }

  let effectiveDateOnly;
  if (hasDueDateOnly) {
    effectiveDateOnly = input.due_date_only;
  } else if (!isCreate && existingTask) {
    effectiveDateOnly = Boolean(existingTask.due_date_only ?? !existingTask.due_at);
  } else {
    effectiveDateOnly = !(hasDueAt && normalizedInputDueAt !== null);
  }

  const timezone = input.timezone || existingTask?.timezone || 'Asia/Dushanbe';

  if (effectiveDateOnly) {
    if (hasDueAt && normalizedInputDueAt !== null) {
      throw new AppError('Противоречивый режим: при due_date_only=true поле due_at должно быть null', 400);
    }
    const resolvedDueDate = hasDueDate
      ? input.due_date
      : (existingTask?.due_date !== undefined ? existingTask.due_date : getBusinessDate());
    return {
      due_at: null,
      due_date: resolvedDueDate,
      due_date_only: true,
      timezone
    };
  }

  const resolvedDueAt = hasDueAt ? normalizedInputDueAt : (existingTask?.due_at ? assertValidDueAtWithTz(existingTask.due_at) : null);
  if (!resolvedDueAt) {
    throw new AppError('В точном режиме (due_date_only=false) требуется корректный due_at', 400);
  }

  return {
    due_at: resolvedDueAt,
    due_date: getBusinessDate(resolvedDueAt),
    due_date_only: false,
    timezone
  };
}

export class TasksRepository {
  static async findAll(filters = {}) {
    const db = getSecureDB();

    let query = db
      .from('tasks')
      .select(`
        *,
        leads ( id, full_name, phone, status ),
        deals ( id, contract_number, status, payment_type ),
        users!assigned_user_id ( id, name, role )
      `)
      .order('created_at', { ascending: false });

    if (filters.status && filters.status !== 'ALL') {
      query = query.eq('status', filters.status);
    }
    if (filters.type && filters.type !== 'ALL') {
      query = query.eq('type', filters.type);
    }
    if (filters.priority && filters.priority !== 'ALL') {
      query = query.eq('priority', filters.priority);
    }
    if (filters.assignedUserId && filters.assignedUserId !== 'ALL') {
      query = query.eq('assigned_user_id', filters.assignedUserId);
    }

    const { data, error } = await query;
    if (error) throw error;

    let tasks = data || [];

    const today = getBusinessDate();

    const nowDate = new Date();
    const isTaskOverdue = (t) => {
      if (t.status !== 'OPEN') return false;
      const dueAtMs = !t.due_date_only && t.due_at ? new Date(t.due_at).getTime() : null;
      if (dueAtMs !== null && Number.isFinite(dueAtMs)) {
        return dueAtMs < nowDate.getTime();
      }
      if (t.due_date && /^\d{4}-\d{2}-\d{2}$/.test(String(t.due_date).slice(0, 10))) {
        const cutoffMs = Date.parse(`${String(t.due_date).slice(0, 10)}T18:00:00+05:00`);
        return Number.isFinite(cutoffMs) ? cutoffMs < nowDate.getTime() : false;
      }
      return false;
    };

    const getTaskBusinessDate = (t) => {
      if (!t.due_date_only && t.due_at) {
        const parsed = new Date(t.due_at);
        if (!Number.isNaN(parsed.getTime())) return getBusinessDate(parsed);
      }
      return t.due_date ? String(t.due_date).slice(0, 10) : null;
    };

    // Filter by date categories if requested
    if (filters.dateFilter === 'TODAY') {
      tasks = tasks.filter((t) => t.status === 'OPEN' && getTaskBusinessDate(t) === today);
    } else if (filters.dateFilter === 'OVERDUE') {
      tasks = tasks.filter((t) => isTaskOverdue(t));
    } else if (filters.dateFilter === 'COMPLETED') {
      tasks = tasks.filter((t) => t.status === 'COMPLETED');
    }

    if (filters.search) {
      const s = filters.search.toLowerCase();
      tasks = tasks.filter(
        (t) =>
          (t.title && t.title.toLowerCase().includes(s)) ||
          (t.client_name && t.client_name.toLowerCase().includes(s)) ||
          (t.phone && t.phone.toLowerCase().includes(s)) ||
          (t.project_name && t.project_name.toLowerCase().includes(s))
      );
    }

    return tasks.map((t) => {
      const isOverdue = isTaskOverdue(t);
      return {
        ...t,
        client_name: t.client_name || t.leads?.full_name || 'Клиент',
        phone: t.phone || t.leads?.phone || '',
        contract_number: t.deals?.contract_number || null,
        assigned_user_name: t.users?.name || 'Ответственный менеджер',
        isOverdue,
        isToday: t.status === 'OPEN' && getTaskBusinessDate(t) === today,
      };
    });
  }

  static async findById(id) {
    const db = getSecureDB();
    const { data, error } = await db
      .from('tasks')
      .select(`
        *,
        leads ( id, full_name, phone ),
        deals ( id, contract_number ),
        users!assigned_user_id ( id, name )
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  }

  static async create(taskData) {
    const db = getSecureDB();
    const now = new Date().toISOString();

    const dueFields = normalizeTaskDueFields(taskData, null, { isCreate: true });

    const insertPayload = {
      lead_id: taskData.lead_id || null,
      deal_id: taskData.deal_id || null,
      assigned_user_id: taskData.assigned_user_id || taskData.responsible_user_id || null,
      created_by: taskData.created_by || null,
      type: taskData.type || 'CALL',
      title: taskData.title,
      description: taskData.description || null,
      client_name: taskData.client_name || null,
      phone: taskData.phone || null,
      project_name: taskData.project_name || null,
      unit_number: taskData.unit_number ? String(taskData.unit_number) : null,
      ...dueFields,
      rule_key: taskData.rule_key || null,
      event_ref: taskData.event_ref || null,
      priority: taskData.priority || 'NORMAL',
      status: taskData.status || 'OPEN',
      idempotency_key: taskData.idempotency_key || null,
      created_at: now,
      updated_at: now,
    };

    try {
      const { data, error } = await db
        .from('tasks')
        .insert([insertPayload])
        .select()
        .single();

      if (error) {
        // Concurrency guard: if partial unique index blocked duplicate open task (code 23505)
        if (error.code === '23505') {
          if (insertPayload.lead_id) {
            const existing = await TasksRepository.findOpenTask(insertPayload.lead_id, insertPayload.type);
            if (existing) return existing;
          }
          if (insertPayload.deal_id) {
            const dealTasks = await TasksRepository.findOpenTasksByDeal(insertPayload.deal_id, insertPayload.type);
            if (dealTasks && dealTasks.length > 0) return dealTasks[0];
          }
        }
        throw error;
      }
      return data;
    } catch (err) {
      if (err.code === '23505') {
        if (insertPayload.lead_id) {
          const existing = await TasksRepository.findOpenTask(insertPayload.lead_id, insertPayload.type);
          if (existing) return existing;
        }
        if (insertPayload.deal_id) {
          const dealTasks = await TasksRepository.findOpenTasksByDeal(insertPayload.deal_id, insertPayload.type);
          if (dealTasks && dealTasks.length > 0) return dealTasks[0];
        }
      }
      throw err;
    }
  }

  static async update(id, updateData) {
    const db = getSecureDB();
    const now = new Date().toISOString();
    const hasAnyDueField = ['due_at', 'due_date', 'due_date_only', 'timezone'].some((k) => updateData[k] !== undefined);

    let dueFields = {};
    if (hasAnyDueField) {
      const { data: existing, error: findErr } = await db
        .from('tasks')
        .select('id, due_at, due_date, due_date_only, timezone')
        .eq('id', id)
        .single();
      if (findErr || !existing) {
        throw new AppError('Задача не найдена', 404);
      }
      dueFields = normalizeTaskDueFields(updateData, existing, { isCreate: false });
    }

    const payload = { ...updateData, ...dueFields, updated_at: now };

    const { data, error } = await db
      .from('tasks')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  static async updateStatus(id, newStatus) {
    const db = getSecureDB();
    const now = new Date().toISOString();

    const payload = {
      status: newStatus,
      updated_at: now,
      completed_at: newStatus === 'COMPLETED' ? now : null,
    };

    const { data, error } = await db
      .from('tasks')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  static async cancelOpenTasksForLead(leadId) {
    const db = getSecureDB();
    const now = new Date().toISOString();
    // Safety rule: strictly cancel ONLY automated contact/follow-up tasks (CALL, MEETING).
    // Financial (PAYMENT_CONTROL), contractual (DOCUMENT), and deal tasks (deal_id != null) are NEVER cancelled.
    await db
      .from('tasks')
      .update({ status: 'CANCELLED', updated_at: now })
      .eq('lead_id', leadId)
      .eq('status', 'OPEN')
      .is('deal_id', null)
      .in('type', ['CALL', 'MEETING']);
  }

  static async reassignOpenTasks(leadId, newManagerId) {
    const db = getSecureDB();
    const now = new Date().toISOString();
    await db
      .from('tasks')
      .update({ assigned_user_id: newManagerId, updated_at: now })
      .eq('lead_id', leadId)
      .eq('status', 'OPEN');
  }

  static async completeFirstContactTasks(leadId) {
    const db = getSecureDB();
    const now = new Date().toISOString();
    await db
      .from('tasks')
      .update({ status: 'COMPLETED', completed_at: now, updated_at: now })
      .eq('lead_id', leadId)
      .eq('type', 'CALL')
      .eq('status', 'OPEN');
  }

  static async findOpenTask(leadId, type = null, titlePrefix = null) {
    const db = getSecureDB();
    let query = db
      .from('tasks')
      .select('*')
      .eq('lead_id', leadId)
      .eq('status', 'OPEN');

    if (type) query = query.eq('type', type);
    const { data, error } = await query;
    if (error || !data) return null;

    if (titlePrefix) {
      return data.find(t => t.title && t.title.startsWith(titlePrefix)) || null;
    }
    return data[0] || null;
  }

  static async findOpenTasksByDeal(dealId, type = null) {
    const db = getSecureDB();
    let query = db
      .from('tasks')
      .select('*')
      .eq('deal_id', dealId)
      .eq('status', 'OPEN');

    if (type) query = query.eq('type', type);
    const { data, error } = await query;
    if (error || !data) return [];
    return data;
  }

  static async delete(id) {
    const db = getSecureDB();
    const { error } = await db.from('tasks').delete().eq('id', id);
    if (error) throw error;
    return true;
  }
}
