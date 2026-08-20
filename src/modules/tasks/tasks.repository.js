import { getDB } from '../../db/connection.js';

export class TasksRepository {
  static async findAll(filters = {}) {
    const db = getDB();

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
    const db = getDB();
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
    const db = getDB();
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
      created_at: now,
      updated_at: now,
    };

    const { data, error } = await db
      .from('tasks')
      .insert([insertPayload])
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  static async update(id, updateData) {
    const db = getDB();
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
    const db = getDB();
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
    const db = getDB();
    const now = new Date().toISOString();
    await db
      .from('tasks')
      .update({ status: 'CANCELLED', updated_at: now })
      .eq('lead_id', leadId)
      .eq('status', 'OPEN');
  }

  static async delete(id) {
    const db = getDB();
    const { error } = await db.from('tasks').delete().eq('id', id);
    if (error) throw error;
    return true;
  }
}
