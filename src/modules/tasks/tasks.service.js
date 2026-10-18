import { TasksRepository } from './tasks.repository.js';
import { getBusinessDate, normalizeToSalesWorkingWindow, calculateSalesSlaDeadline } from '../leads/leadSla.service.js';

const inFlightTaskLocks = new Set();

export class TasksService {
  static _clearTaskLocks() {
    inFlightTaskLocks.clear();
  }

  /**
   * Called when a new lead is created
   */
  static async onLeadCreated(lead, creatorId) {
    if (!lead || !lead.responsible_user_id) return;
    try {
      // Idempotency: verify if first contact task already exists
      const existing = await TasksRepository.findOpenTask(lead.id, 'CALL', 'Первичный контакт');
      if (existing) return existing;

      const lockKey = `lead_created_${lead.id}`;
      if (inFlightTaskLocks.has(lockKey)) {
        return await TasksRepository.findOpenTask(lead.id, 'CALL', 'Первичный контакт');
      }
      inFlightTaskLocks.add(lockKey);
      setTimeout(() => inFlightTaskLocks.delete(lockKey), 5000);

      const deadline = calculateSalesSlaDeadline(new Date(), 15);
      const dueDate = deadline ? deadline.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

      return await TasksRepository.create({
        lead_id: lead.id,
        assigned_user_id: lead.responsible_user_id,
        created_by: creatorId || lead.responsible_user_id,
        type: 'CALL',
        priority: 'HIGH',
        title: `Первичный контакт (15 мин SLA): ${lead.full_name}`,
        description: `Связаться с новым потенциальным клиентом в течение 15 минут. Источник: ${lead.source || 'Прямой контакт'}. Регламент: Asia/Dushanbe.`,
        client_name: lead.full_name,
        phone: lead.phone,
        due_date: dueDate,
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
        const existing = await TasksRepository.findOpenTask(lead.id, 'CALL', 'Первичный контакт');
        if (existing) return existing;

        const lockKey = `lead_assigned_${lead.id}_${managerId}`;
        if (inFlightTaskLocks.has(lockKey)) {
          return await TasksRepository.findOpenTask(lead.id, 'CALL', 'Первичный контакт');
        }
        inFlightTaskLocks.add(lockKey);
        setTimeout(() => inFlightTaskLocks.delete(lockKey), 5000);

        const deadline = calculateSalesSlaDeadline(new Date(), 15);
        const dueDate = deadline ? deadline.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

        return await TasksRepository.create({
          lead_id: lead.id,
          assigned_user_id: managerId,
          created_by: assignedById || managerId,
          type: 'CALL',
          priority: 'HIGH',
          title: `Первичный контакт (15 мин SLA): ${lead.full_name}`,
          description: `Связаться с назначенным клиентом в течение 15 минут. Источник: ${lead.source || 'Прямой контакт'}. Регламент: Asia/Dushanbe.`,
          client_name: lead.full_name,
          phone: lead.phone,
          due_date: dueDate,
          status: 'OPEN',
        });
      }
    } catch (err) {
      console.error('Error generating task on lead assigned:', err);
    }
  }

  /**
   * Called when first contact outcome is recorded
   * Automated rules:
   * - If NO_ANSWER / UNREACHABLE: schedule follow-up call +24h working time
   * - If INTERESTED: schedule task for next_contact_date
   * - If REFUSED / LOST: cancel open tasks
   */
  static async onFirstContactOutcome(lead, outcome, details = {}, actorUserId = null) {
    if (!lead || !lead.id) return;
    const managerId = lead.responsible_user_id || actorUserId;
    if (!managerId) return;

    try {
      // 1. Mark existing first contact task as completed
      await TasksRepository.completeFirstContactTasks(lead.id);

      const upperOutcome = String(outcome || '').toUpperCase();

      // Rule A: Client did not answer -> schedule follow-up call in 24 hours (next working day)
      if (['NO_ANSWER', 'UNREACHABLE', 'BUSY'].includes(upperOutcome)) {
        const existingFollowup = await TasksRepository.findOpenTask(lead.id, 'CALL', 'Повторный контакт');
        if (!existingFollowup) {
          // Calculate 24h normalized working window in Asia/Dushanbe
          const now = new Date();
          const targetRaw = new Date(now.getTime() + 24 * 3600 * 1000);
          const normalized = normalizeToSalesWorkingWindow(targetRaw);
          const dueDate = normalized.toISOString().split('T')[0];

          await TasksRepository.create({
            lead_id: lead.id,
            assigned_user_id: managerId,
            created_by: actorUserId || managerId,
            type: 'CALL',
            priority: 'HIGH',
            title: `Повторный контакт (не ответил): ${lead.full_name}`,
            description: `Клиент не ответил при первом звонке (${outcome}). Повторный контакт запланирован через 24 часа в рабочее время Asia/Dushanbe.`,
            client_name: lead.full_name,
            phone: lead.phone,
            due_date: dueDate,
            status: 'OPEN',
          });
        }
      }

      // Rule B: Client is interested -> schedule next contact on agreed date
      if (['INTERESTED', 'QUALIFIED', 'CALLBACK_REQUESTED'].includes(upperOutcome)) {
        const targetDate = details.next_contact_date || details.agreed_date || null;
        if (targetDate) {
          const existingAgreed = await TasksRepository.findOpenTask(lead.id, 'CALL', 'Запланированный контакт');
          if (!existingAgreed) {
            await TasksRepository.create({
              lead_id: lead.id,
              assigned_user_id: managerId,
              created_by: actorUserId || managerId,
              type: 'CALL',
              priority: 'NORMAL',
              title: `Запланированный контакт: ${lead.full_name}`,
              description: details.comment || `Согласованный звонок клиенту. Результат квалификации: ${outcome}.`,
              client_name: lead.full_name,
              phone: lead.phone,
              due_date: String(targetDate).split('T')[0],
              status: 'OPEN',
            });
          }
        }
      }

      // Rule C: Client refused -> cancel open tasks
      if (['REFUSED', 'NOT_INTERESTED', 'LOST'].includes(upperOutcome)) {
        await TasksRepository.cancelOpenTasksForLead(lead.id);
      }
    } catch (err) {
      console.error('Error handling first contact outcome in TasksService:', err);
    }
  }

  /**
   * Called when an existing client submits a repeated inquiry
   */
  static async onRepeatInquiry(lead, managerId, source) {
    if (!lead || !managerId) return;
    try {
      const existing = await TasksRepository.findOpenTask(lead.id, 'CALL', 'Повторное обращение');
      if (existing) return existing;

      const today = new Date().toISOString().split('T')[0];
      return await TasksRepository.create({
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
        const existing = await TasksRepository.findOpenTask(lead.id, 'CALL', 'Квалификация потребностей');
        if (!existing) {
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
        }
      } else if (newStatus === 'NEGOTIATION') {
        const existing = await TasksRepository.findOpenTask(lead.id, 'MEETING', 'Встреча в офисе');
        if (!existing) {
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
        }
      } else if (newStatus === 'WON') {
        const existing = await TasksRepository.findOpenTask(lead.id, 'DOCUMENT', 'Оформление брони');
        if (!existing) {
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
        }
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
      const todayStr = today.toISOString().split('T')[0];
      const expiryDate = deal.reservation_expires_at 
        ? deal.reservation_expires_at.split('T')[0]
        : new Date(today.getTime() + 3 * 86400000).toISOString().split('T')[0];

      if (deal.status === 'RESERVED') {
        const lockKey = `deal_reserved_${deal.id}`;
        if (inFlightTaskLocks.has(lockKey)) return;
        inFlightTaskLocks.add(lockKey);
        setTimeout(() => inFlightTaskLocks.delete(lockKey), 5000);

        // Idempotency: verify no open reservation expiry task exists for this deal
        const openExpiryTasks = await TasksRepository.findOpenTasksByDeal(deal.id, 'RESERVATION_EXPIRY');
        if (openExpiryTasks.length === 0) {
          let isOverdue = false;
          let isShort = false;

          if (deal.reservation_expires_at) {
            const expTime = new Date(deal.reservation_expires_at).getTime();
            const nowTime = today.getTime();
            const diffMs = expTime - nowTime;
            const diffHours = diffMs / (1000 * 3600);
            if (diffMs <= 0) {
              isOverdue = true;
            } else if (diffHours <= 48) {
              isShort = true;
            }
          }

          let titlePrefix = 'Контроль брони';
          let description = 'Истекает срок бронирования квартиры. Уточнить финальное решение покупателя и подготовить договор.';
          let taskDueDate = expiryDate;

          if (isOverdue) {
            titlePrefix = '[ПРОСРОЧЕНА] Контроль брони';
            description = 'Внимание: срок бронирования истек! Требуется немедленно подтвердить сделку или снять бронь в шахматке.';
            taskDueDate = todayStr;
          } else if (isShort) {
            titlePrefix = '[СРОЧНО <48ч] Контроль брони';
            description = 'Короткий срок бронирования (<48 часов). Требуется оперативно связаться с клиентом для внесения аванса или заключения договора.';
          }

          await TasksRepository.create({
            lead_id: deal.lead_id,
            deal_id: deal.id,
            assigned_user_id: deal.responsible_user_id || creatorId,
            created_by: creatorId,
            type: 'RESERVATION_EXPIRY',
            priority: 'HIGH',
            title: `${titlePrefix}: кв. №${deal.unit_number || deal.unit_id} (Договор ${deal.contract_number || 'Бронь'})`,
            description,
            client_name: deal.lead_name || 'Покупатель',
            phone: deal.lead_phone || '',
            project_name: deal.project_name || '',
            unit_number: String(deal.unit_number || deal.unit_id),
            due_date: taskDueDate,
            status: 'OPEN',
          });
        }
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
      const lockKey = `deal_signed_${deal.id}`;
      if (inFlightTaskLocks.has(lockKey)) return;
      inFlightTaskLocks.add(lockKey);
      setTimeout(() => inFlightTaskLocks.delete(lockKey), 5000);

      // Idempotency check
      const openPaymentTasks = await TasksRepository.findOpenTasksByDeal(deal.id, 'PAYMENT_CONTROL');
      if (openPaymentTasks.length > 0) return;

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
