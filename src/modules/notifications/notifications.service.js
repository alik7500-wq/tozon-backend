import { NotificationsRepository } from './notifications.repository.js';

export class NotificationsService {
  static async getUserNotifications(userId, filters) {
    return NotificationsRepository.getUserNotifications(userId, filters);
  }

  static async getUnreadCount(userId) {
    return NotificationsRepository.getUnreadCount(userId);
  }

  static async getNotificationStats(userId) {
    return NotificationsRepository.getNotificationStats(userId);
  }

  static async markAsRead(notificationId, userId) {
    return NotificationsRepository.markAsRead(notificationId, userId);
  }

  static async markAllAsRead(userId) {
    return NotificationsRepository.markAllAsRead(userId);
  }

  // Helper to determine recipient IDs for an entity
  static async resolveRecipients(responsibleUserId) {
    const adminIds = await NotificationsRepository.getAdminUserIds();
    const recipientSet = new Set(adminIds);
    if (responsibleUserId && Number(responsibleUserId) > 0) {
      recipientSet.add(Number(responsibleUserId));
    }
    return Array.from(recipientSet);
  }

  // 1. LEAD_CREATED Event Notification
  static async notifyLeadCreated(lead) {
    if (!lead || !lead.id) return;
    const recipientIds = await this.resolveRecipients(lead.responsible_user_id);

    const leadName = lead.full_name || lead.name || 'Клиент';
    const phoneStr = lead.phone ? ` (${lead.phone})` : '';

    for (const userId of recipientIds) {
      await NotificationsRepository.createNotification({
        user_id: userId,
        type: 'LEAD_CREATED',
        title: 'Новый входящий лид',
        message: `Поступила новая заявка: ${leadName}${phoneStr}`,
        entity_type: 'LEAD',
        entity_id: lead.id,
        dedupe_key: `LEAD_CREATED:${lead.id}:${userId}`,
        metadata: { lead_id: lead.id, phone: lead.phone }
      });
    }
  }

  // 2. RESERVATION_CREATED Event Notification
  static async notifyReservationCreated(deal) {
    if (!deal || !deal.id) return;
    const recipientIds = await this.resolveRecipients(deal.responsible_user_id);

    const contractStr = deal.contract_number ? `№${deal.contract_number}` : `№${deal.id}`;
    const unitStr = deal.unit_number ? `квартиру №${deal.unit_number}` : 'объект';

    for (const userId of recipientIds) {
      await NotificationsRepository.createNotification({
        user_id: userId,
        type: 'RESERVATION_CREATED',
        title: 'Успешно оформлена новая бронь',
        message: `Забронирована ${unitStr} по договору ${contractStr}.`,
        entity_type: 'DEAL',
        entity_id: deal.id,
        dedupe_key: `RESERVATION_CREATED:${deal.id}:${userId}`,
        metadata: { deal_id: deal.id, unit_number: deal.unit_number }
      });
    }
  }

  // 3. PAYMENT_DUE Event Notification
  static async notifyPaymentDue(schedule, deal) {
    if (!schedule || !schedule.id || !deal || !deal.id) return;
    const recipientIds = await this.resolveRecipients(deal.responsible_user_id);

    const contractStr = deal.contract_number ? `№${deal.contract_number}` : `№${deal.id}`;
    const clientName = deal.lead_name || deal.buyer_name || 'Клиент';

    for (const userId of recipientIds) {
      await NotificationsRepository.createNotification({
        user_id: userId,
        type: 'PAYMENT_DUE',
        title: 'Наступает срок планового платежа',
        message: `По договору ${contractStr} (${clientName}) срок оплаты взноса ${schedule.due_date}.`,
        entity_type: 'DEAL',
        entity_id: deal.id,
        dedupe_key: `PAYMENT_DUE:${schedule.id}:${userId}`,
        metadata: { deal_id: deal.id, schedule_id: schedule.id, due_date: schedule.due_date }
      });
    }
  }

  // 4. PAYMENT_OVERDUE Event Notification
  static async notifyPaymentOverdue(schedule, deal) {
    if (!schedule || !schedule.id || !deal || !deal.id) return;
    const recipientIds = await this.resolveRecipients(deal.responsible_user_id);

    const contractStr = deal.contract_number ? `№${deal.contract_number}` : `№${deal.id}`;
    const clientName = deal.lead_name || deal.buyer_name || 'Клиент';

    for (const userId of recipientIds) {
      await NotificationsRepository.createNotification({
        user_id: userId,
        type: 'PAYMENT_OVERDUE',
        title: 'Просрочен плановый платеж',
        message: `По договору ${contractStr} (${clientName}) просрочен платеж от ${schedule.due_date}.`,
        entity_type: 'DEAL',
        entity_id: deal.id,
        dedupe_key: `PAYMENT_OVERDUE:${schedule.id}:${userId}`,
        metadata: { deal_id: deal.id, schedule_id: schedule.id, due_date: schedule.due_date }
      });
    }
  }

  // 5. SMS_FAILED Event Notification
  static async notifySmsFailed(smsMessage) {
    if (!smsMessage || !smsMessage.id) return;
    const adminIds = await NotificationsRepository.getAdminUserIds();

    const recipientPhone = smsMessage.recipient_phone || smsMessage.phone || 'клиенту';
    const failureReason = smsMessage.error_message || smsMessage.errorMessage || smsMessage.failure_message || smsMessage.failure_code || 'Сбой доставки';
    const createdDate = smsMessage.created_at || smsMessage.sent_at || new Date().toISOString();

    for (const userId of adminIds) {
      await NotificationsRepository.createNotification({
        user_id: userId,
        type: 'SMS_FAILED',
        title: 'Ошибка автоматической отправки SMS',
        message: `Сбой отправки SMS (ID #${smsMessage.id}) на номер ${recipientPhone}: ${failureReason}.`,
        entity_type: 'SMS',
        entity_id: smsMessage.id,
        dedupe_key: `SMS_FAILED:${smsMessage.id}:${userId}`,
        metadata: { sms_id: smsMessage.id, phone: recipientPhone, failure_reason: failureReason, created_at: createdDate }
      });
    }
  }

  // 6. LEAD_UNASSIGNED Event Notification
  static async notifyLeadUnassigned(lead) {
    if (!lead || !lead.id) return;
    const adminIds = await NotificationsRepository.getAdminUserIds();
    if (!adminIds || adminIds.length === 0) return;

    const leadName = lead.full_name || lead.name || 'Клиент';

    for (const userId of adminIds) {
      await NotificationsRepository.createNotification({
        user_id: userId,
        type: 'LEAD_UNASSIGNED',
        title: 'Новый неназначенный лид',
        message: `Новый лид ${leadName} поступил в систему и ожидает назначения ответственного менеджера.`,
        entity_type: 'LEAD',
        entity_id: lead.id,
        action_url: `/clients?clientId=${lead.id}`,
        dedupe_key: `LEAD_UNASSIGNED:${lead.id}:${userId}`,
        metadata: { lead_id: lead.id, phone: lead.phone }
      });
    }
  }

  // 7. MANAGER_TASK_OVERDUE Event Notification
  static async notifyManagerTaskOverdue(task) {
    if (!task || !task.id) return;
    const recipientIds = await this.resolveRecipients(task.assigned_user_id);

    const clientName = task.client_name || task.leads?.full_name || 'Клиент';
    const taskTitle = task.title || 'Задача';

    const entityType = task.lead_id ? 'LEAD' : (task.deal_id ? 'DEAL' : 'TASK');
    const entityId = task.lead_id || task.deal_id || task.id;
    const actionUrl = task.lead_id ? `/clients?clientId=${task.lead_id}` : (task.deal_id ? `/deals?dealId=${task.deal_id}` : '/tasks');

    for (const userId of recipientIds) {
      await NotificationsRepository.createNotification({
        user_id: userId,
        type: 'MANAGER_TASK_OVERDUE',
        title: 'Просрочена задача сотрудника',
        message: `Просрочена задача "${taskTitle}" (Клиент: ${clientName}) со сроком ${task.due_date}.`,
        entity_type: entityType,
        entity_id: entityId,
        action_url: actionUrl,
        dedupe_key: `MANAGER_TASK_OVERDUE:${task.id}:${userId}:${task.due_date}`,
        metadata: { task_id: task.id, due_date: task.due_date, assigned_user_id: task.assigned_user_id }
      });
    }
  }

  // 8. CALL_REMINDER Event Notification
  static async notifyCallReminder(task) {
    if (!task || !task.id || !task.assigned_user_id) return;
    const userId = Number(task.assigned_user_id);

    const clientName = task.client_name || task.leads?.full_name || 'Клиент';
    const timeStr = task.time ? ` Время: ${task.time}.` : '';

    await NotificationsRepository.createNotification({
      user_id: userId,
      type: 'CALL_REMINDER',
      title: 'Напоминание о звонке',
      message: `На сегодня запланирован звонок клиенту ${clientName}: "${task.title}".${timeStr}`,
      entity_type: task.lead_id ? 'LEAD' : 'TASK',
      entity_id: task.lead_id || task.id,
      action_url: task.lead_id ? `/clients?clientId=${task.lead_id}` : '/tasks',
      dedupe_key: `CALL_REMINDER:${task.id}:${userId}:${task.due_date}`,
      metadata: { task_id: task.id, due_date: task.due_date, time: task.time || null }
    });
  }

  // 9. MEETING_REMINDER Event Notification
  static async notifyMeetingReminder(task) {
    if (!task || !task.id || !task.assigned_user_id) return;
    const userId = Number(task.assigned_user_id);

    const clientName = task.client_name || task.leads?.full_name || 'Клиент';
    const timeStr = task.time ? ` Время: ${task.time}.` : '';

    await NotificationsRepository.createNotification({
      user_id: userId,
      type: 'MEETING_REMINDER',
      title: 'Напоминание о встрече',
      message: `На сегодня запланирована встреча с клиентом ${clientName}: "${task.title}".${timeStr}`,
      entity_type: task.lead_id ? 'LEAD' : 'TASK',
      entity_id: task.lead_id || task.id,
      action_url: task.lead_id ? `/clients?clientId=${task.lead_id}` : '/tasks',
      dedupe_key: `MEETING_REMINDER:${task.id}:${userId}:${task.due_date}`,
      metadata: { task_id: task.id, due_date: task.due_date, time: task.time || null }
    });
  }
}
