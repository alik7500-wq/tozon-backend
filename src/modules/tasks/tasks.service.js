import { TasksRepository } from './tasks.repository.js';

export class TasksService {
  /**
   * Called when a new lead is created
   */
  static async onLeadCreated(lead, creatorId) {
    // If lead has no responsible user, it stays in the unassigned pool; no personal call task is generated yet.
    if (!lead || !lead.responsible_user_id) return;
    try {
      const today = new Date().toISOString().split('T')[0];
      await TasksRepository.create({
        lead_id: lead.id,
        assigned_user_id: lead.responsible_user_id,
        created_by: creatorId || lead.responsible_user_id,
        type: 'CALL',
        priority: 'HIGH',
        title: `Первичный контакт (15 мин SLA): ${lead.full_name}`,
        description: `Связаться с новым потенциальным клиентом в течение 15 минут. Источник: ${lead.source || 'Прямой контакт'}.`,
        client_name: lead.full_name,
        phone: lead.phone,
        due_date: today,
        status: 'OPEN',
      });
    } catch (err) {
      console.error('Error generating task on lead created:', err);
    }
  }

  /**
   * Called when an unassigned lead is assigned to a manager
   */
  static async onLeadAssigned(lead, managerId, assignedById) {
    if (!lead || !managerId) return;
    try {
      // Reassign any existing open tasks for this lead to the new manager
      await TasksRepository.reassignOpenTasks(lead.id, managerId);

      // Only generate 15-min SLA call task if primary contact has NOT yet been established
      if (!lead.first_contact_at) {
        const today = new Date().toISOString().split('T')[0];
        await TasksRepository.create({
          lead_id: lead.id,
          assigned_user_id: managerId,
          created_by: assignedById || managerId,
          type: 'CALL',
          priority: 'HIGH',
          title: `Первичный контакт (15 мин SLA): ${lead.full_name}`,
          description: `Связаться с назначенным клиентом в течение 15 минут. Источник: ${lead.source || 'Прямой контакт'}.`,
          client_name: lead.full_name,
          phone: lead.phone,
          due_date: today,
          status: 'OPEN',
        });
      }
    } catch (err) {
      console.error('Error generating task on lead assigned:', err);
    }
  }

  /**
   * Called when an existing client submits a repeated inquiry
   */
  static async onRepeatInquiry(lead, managerId, source) {
    if (!lead || !managerId) return;
    try {
      const today = new Date().toISOString().split('T')[0];
      await TasksRepository.create({
        lead_id: lead.id,
        assigned_user_id: managerId,
        created_by: managerId,
        type: 'CALL',
        priority: 'HIGH',
        title: `Повторное обращение клиента: ${lead.full_name}`,
        description: `Клиент повторно оставил заявку из источника: ${source || 'Онлайн'}. Срочно связаться и уточнить детали.`,
        client_name: lead.full_name,
        phone: lead.phone,
        due_date: today,
        status: 'OPEN',
      });
    } catch (err) {
      console.error('Error generating task on repeat inquiry:', err);
    }
  }

  /**
   * Called when first contact is recorded for a lead
   */
  static async onFirstContactRecorded(leadId) {
    try {
      await TasksRepository.completeFirstContactTasks(leadId);
    } catch (err) {
      console.error('Error completing first contact task:', err);
    }
  }

  /**
   * Called when a lead status changes
   */
  static async onLeadStatusChanged(lead, newStatus, userId) {
    try {
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const tomorrowStr = new Date(today.getTime() + 86400000).toISOString().split('T')[0];

      if (newStatus === 'IN_PROGRESS') {
        await TasksRepository.create({
          lead_id: lead.id,
          assigned_user_id: lead.responsible_user_id || userId,
          created_by: userId,
          type: 'CALL',
          priority: 'NORMAL',
          title: `Квалификация потребностей: ${lead.full_name}`,
          description: `Уточнить предпочитаемый ЖК, этаж, бюджет и условия оплаты.`,
          client_name: lead.full_name,
          phone: lead.phone,
          due_date: todayStr,
          status: 'OPEN',
        });
      } else if (newStatus === 'NEGOTIATION') {
        await TasksRepository.create({
          lead_id: lead.id,
          assigned_user_id: lead.responsible_user_id || userId,
          created_by: userId,
          type: 'MEETING',
          priority: 'HIGH',
          title: `Встреча в офисе / показ планировок: ${lead.full_name}`,
          description: `Провести презентацию объекта в офисе или на стройплощадке. Подготовить предварительный расчет.`,
          client_name: lead.full_name,
          phone: lead.phone,
          due_date: tomorrowStr,
          status: 'OPEN',
        });
      } else if (newStatus === 'WON') {
        await TasksRepository.create({
          lead_id: lead.id,
          assigned_user_id: lead.responsible_user_id || userId,
          created_by: userId,
          type: 'DOCUMENT',
          priority: 'HIGH',
          title: `Оформление брони и договора: ${lead.full_name}`,
          description: `Собрать паспортные данные покупателя, зафиксировать условия рассрочки и сформировать договор.`,
          client_name: lead.full_name,
          phone: lead.phone,
          due_date: todayStr,
          status: 'OPEN',
        });
      } else if (newStatus === 'LOST') {
        await TasksRepository.cancelOpenTasksForLead(lead.id);
      }
    } catch (err) {
      console.error('Error generating task on lead status change:', err);
    }
  }

  /**
   * Called when a deal or reservation is created
   */
  static async onDealCreated(deal, creatorId) {
    try {
      const today = new Date();
      const expiryDate = deal.reservation_expires_at 
        ? deal.reservation_expires_at.split('T')[0]
        : new Date(today.getTime() + 3 * 86400000).toISOString().split('T')[0];

      if (deal.status === 'RESERVED') {
        await TasksRepository.create({
          lead_id: deal.lead_id,
          deal_id: deal.id,
          assigned_user_id: deal.responsible_user_id || creatorId,
          created_by: creatorId,
          type: 'RESERVATION_EXPIRY',
          priority: 'HIGH',
          title: `Контроль брони: кв. №${deal.unit_number || deal.unit_id} (Договор ${deal.contract_number || 'Бронь'})`,
          description: `Истекает срок бронирования квартиры. Уточнить финальное решение покупателя и подготовить договор.`,
          client_name: deal.lead_name || 'Покупатель',
          phone: deal.lead_phone || '',
          project_name: deal.project_name || '',
          unit_number: String(deal.unit_number || deal.unit_id),
          due_date: expiryDate,
          status: 'OPEN',
        });
      }
    } catch (err) {
      console.error('Error generating task on deal created:', err);
    }
  }

  /**
   * Called when a deal is signed
   */
  static async onDealSigned(deal, userId) {
    try {
      const targetDate = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
      await TasksRepository.create({
        lead_id: deal.lead_id,
        deal_id: deal.id,
        assigned_user_id: deal.responsible_user_id || userId,
        created_by: userId,
        type: 'PAYMENT_CONTROL',
        priority: 'NORMAL',
        title: `Контроль первого взноса: Договор №${deal.contract_number}`,
        description: `Проверить поступление первого взноса в кассу по утвержденному договору купли-продажи.`,
        client_name: deal.lead_name || 'Покупатель',
        phone: deal.lead_phone || '',
        due_date: targetDate,
        status: 'OPEN',
      });
    } catch (err) {
      console.error('Error generating task on deal signed:', err);
    }
  }
}
