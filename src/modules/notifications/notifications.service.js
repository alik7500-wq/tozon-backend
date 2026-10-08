import { NotificationsRepository } from './notifications.repository.js';

export class NotificationsService {
  static async getUserNotifications(userId, filters) {
    return NotificationsRepository.getUserNotifications(userId, filters);
  }

  static async getUnreadCount(userId) {
    return NotificationsRepository.getUnreadCount(userId);
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
}
