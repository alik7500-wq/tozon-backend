import { getDB, getServiceDB } from '../../db/connection.js';

const getSecureDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

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

    const today = new Date().toISOString().split('T')[0];

    // Filter by date categories if requested
    if (filters.dateFilter === 'TODAY') {
      tasks = tasks.filter((t) => t.due_date === today && t.status === 'OPEN');
    } else if (filters.dateFilter === 'OVERDUE') {
      tasks = tasks.filter((t) => t.due_date < today && t.status === 'OPEN');
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

    return tasks.map((t) => ({
      ...t,
      client_name: t.client_name || t.leads?.full_name || 'Клиент',
      phone: t.phone || t.leads?.phone || '',
      contract_number: t.deals?.contract_number || null,
      assigned_user_name: t.users?.name || 'Ответственный менеджер',
      isOverdue: t.status === 'OPEN' && t.due_date < today,
      isToday: t.status === 'OPEN' && t.due_date === today,
    }));
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
      due_date: taskData.due_date || now.split('T')[0],
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

    const { data, error } = await db
      .from('tasks')
      .update({ ...updateData, updated_at: now })
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
