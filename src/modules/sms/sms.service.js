import { PayomSmsProvider } from './sms.provider.js';
import { SmsRepository } from './sms.repository.js';
import { LeadsRepository } from '../leads/leads.repository.js';
import { DealsRepository } from '../deals/deals.repository.js';
import { TasksRepository } from '../tasks/tasks.repository.js';
import { normalizePhoneNumber } from '../../utils/phoneNormalizer.js';
import { parseOptionalBigInt } from '../../utils/idNormalizer.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class SmsService {
  constructor(smsProvider = new PayomSmsProvider()) {
    this.provider = smsProvider;
  }

  /**
   * Helper to calculate deal payment schedule data according to CRM ground truth FIFO rules:
   * - overdue_amount: SUM(amount_minor - paid_amount_minor) for schedules with due_date < today and unpaid balance > 0.
   * - remaining_balance: final_price_minor - total_paid_minor.
   * - next_schedule: single schedule row with due_date >= today (or first unpaid schedule).
   */
  async calculateDealContext(dealId, todayStr) {
    const deal = await DealsRepository.getDealById(dealId);
    if (!deal) return null;

    const today = todayStr || new Date().toISOString().split('T')[0];
    const rawSchedules = deal.deal_payment_schedules || [];

    // Filter overdue schedules: due_date < today AND remaining unpaid > 0
    const overdueSchedules = rawSchedules.filter((s) => {
      const planned = s.amount_minor || 0;
      const paid = s.paid_amount_minor || 0;
      return s.due_date < today && planned - paid > 0;
    });

    const overdueMinor = overdueSchedules.reduce((sum, s) => {
      const planned = s.amount_minor || 0;
      const paid = s.paid_amount_minor || 0;
      return sum + Math.max(0, planned - paid);
    }, 0);

    const activePayments = (deal.payments || []).filter((p) => p.status !== 'VOIDED');
    const totalPaidMinor = activePayments.reduce((sum, p) => sum + (p.amount_minor || 0), 0);
    const remainingBalanceMinor = Math.max(0, (deal.final_price_minor || 0) - totalPaidMinor);

    // Unpaid schedules for PAYMENT_REMINDER
    const unpaidSchedules = [...rawSchedules]
      .sort((a, b) => a.payment_number - b.payment_number)
      .filter((s) => (s.amount_minor || 0) - (s.paid_amount_minor || 0) > 0);

    const upcomingSchedules = unpaidSchedules.filter((s) => s.due_date >= today);
    const nextSchedule = upcomingSchedules[0] || unpaidSchedules[0] || null;

    const rawCurrency = deal.currency || deal.project_currency || deal.units?.floors?.sections?.buildings?.projects?.currency || null;
    const ALLOWED_CURRENCIES = ['USD', 'TJS', 'RUB'];
    const currency = (rawCurrency && typeof rawCurrency === 'string' && ALLOWED_CURRENCIES.includes(rawCurrency.trim().toUpperCase()))
      ? rawCurrency.trim().toUpperCase()
      : null;

    return {
      deal,
      currency,
      overdueMinor,
      overdueAmountFormatted: (overdueMinor / 100).toLocaleString('ru-RU'),
      remainingBalanceMinor,
      remainingBalanceFormatted: (remainingBalanceMinor / 100).toLocaleString('ru-RU'),
      nextSchedule: nextSchedule
        ? {
            id: nextSchedule.id,
            payment_number: nextSchedule.payment_number,
            due_date: nextSchedule.due_date,
            amount_minor: nextSchedule.amount_minor,
            paid_amount_minor: nextSchedule.paid_amount_minor,
            unpaid_amount_minor: Math.max(0, (nextSchedule.amount_minor || 0) - (nextSchedule.paid_amount_minor || 0)),
            paymentAmountFormatted: (
              Math.max(0, (nextSchedule.amount_minor || 0) - (nextSchedule.paid_amount_minor || 0)) / 100
            ).toLocaleString('ru-RU')
          }
        : null
    };
  }

  /**
   * Single authoritative server-side template resolver used by preview and send.
   */
  async resolveTemplate({
    templateCode = null,
    text = null,
    clientId = null,
    dealId = null,
    taskId = null,
    meetingId = null,
    todayStr = null
  }) {
    const normClientId = parseOptionalBigInt(clientId);
    const normDealId = parseOptionalBigInt(dealId);
    const normTaskId = parseOptionalBigInt(taskId || meetingId);

    let templateText = text;
    let code = templateCode;

    // 1. If template code is specified and not CUSTOM_MESSAGE, fetch canonical template text from DB
    if (code && code !== 'CUSTOM_MESSAGE') {
      const templates = await SmsRepository.getTemplates();
      const tmpl = templates.find((t) => t.code === code && t.is_active);
      if (tmpl) {
        templateText = tmpl.text;
      } else if (!templateText) {
        throw new AppError(`Шаблон ${code} не найден или неактивен`, 404);
      }
    }

    if (!templateText || typeof templateText !== 'string' || !templateText.trim()) {
      throw new AppError('Текст шаблона не может быть пустым', 400);
    }

    let resolvedText = templateText.trim();

    // 2. Fetch Lead Context if clientId is present or can be resolved from deal/task
    let lead = null;
    let targetClientId = normClientId;

    if (!targetClientId && normDealId) {
      const dealObj = await DealsRepository.getDealById(normDealId);
      if (dealObj) targetClientId = parseOptionalBigInt(dealObj.lead_id);
    } else if (!targetClientId && normTaskId) {
      const taskObj = await TasksRepository.findById(normTaskId);
      if (taskObj) targetClientId = parseOptionalBigInt(taskObj.lead_id);
    }

    if (targetClientId) {
      lead = await LeadsRepository.findById(targetClientId);
      if (!lead && (code === 'CLIENT_WELCOME' || code === 'MEETING_REMINDER' || code === 'DEAL_INFO' || code === 'PAYMENT_REMINDER' || code === 'DEBTOR_REMINDER')) {
        throw new AppError(`Клиент с ID ${targetClientId} не найден`, 404);
      }
    }

    const clientName = lead ? lead.full_name : '';
    resolvedText = resolvedText.replace(/\{\{\s*client_name\s*\}\}/g, clientName);
    resolvedText = resolvedText.replace(/\{\{\s*customerName\s*\}\}/g, clientName);

    // 3. Resolve Meeting Context (MEETING_REMINDER)
    const requiresMeetingContext =
      code === 'MEETING_REMINDER' ||
      (normTaskId && (resolvedText.includes('{{meeting_date}}') || resolvedText.includes('{{meeting_time}}')));

    if (code === 'MEETING_REMINDER') {
      if (!normTaskId && !targetClientId) {
        throw new AppError('Контекст клиента обязателен для шаблона встречи', 400);
      }
    }

    if (requiresMeetingContext || (code === 'MEETING_REMINDER' && targetClientId)) {
      let task = null;
      if (normTaskId) {
        task = await TasksRepository.findById(normTaskId);
        if (!task) {
          throw new AppError('Для клиента не найдена запланированная встреча', 404);
        }
        if (targetClientId && parseOptionalBigInt(task.lead_id) !== targetClientId) {
          throw new AppError('Встреча не принадлежит указанному клиенту', 400);
        }
      } else if (targetClientId) {
        const tasks = await TasksRepository.findAll({ assignedUserId: 'ALL' });
        const meetingTask = tasks.find(
          (t) =>
            parseOptionalBigInt(t.lead_id) === targetClientId &&
            (t.type === 'MEETING' || (t.title && t.title.toLowerCase().includes('встреч'))) &&
            t.status === 'OPEN'
        );
        if (!meetingTask) {
          throw new AppError('Для клиента не найдена запланированная встреча', 400);
        }
        task = meetingTask;
      }

      if (task) {
        const meetingDate = task.due_date || (task.due_at ? task.due_at.split('T')[0] : '');
        const meetingTime = task.due_time || (task.due_at && task.due_at.includes('T') ? task.due_at.split('T')[1].slice(0, 5) : '10:00');

        if (!meetingDate) {
          throw new AppError('Для встречи не указана дата', 400);
        }

        resolvedText = resolvedText.replace(/\{\{\s*meeting_date\s*\}\}/g, meetingDate);
        resolvedText = resolvedText.replace(/\{\{\s*meeting_time\s*\}\}/g, meetingTime);
      }
    }

    // 4. Resolve Deal / Payment / Debtor Context
    if (code === 'DEAL_INFO' || code === 'PAYMENT_REMINDER' || code === 'DEBTOR_REMINDER') {
      if (!normDealId) {
        throw new AppError('Контекст сделки обязателен для данного шаблона', 400);
      }
    }

    const requiresDealContext =
      code === 'DEAL_INFO' ||
      code === 'PAYMENT_REMINDER' ||
      code === 'DEBTOR_REMINDER' ||
      (normDealId && (
        resolvedText.includes('{{contract_number}}') ||
        resolvedText.includes('{{payment_amount}}') ||
        resolvedText.includes('{{overdue_amount}}') ||
        resolvedText.includes('{{currency}}') ||
        resolvedText.includes('{{apartment}}') ||
        resolvedText.includes('{{project_name}}')
      ));

    if (requiresDealContext && normDealId) {
      const dealContext = await this.calculateDealContext(normDealId, todayStr);
      if (!dealContext || !dealContext.deal) {
        throw new AppError('Сделка не найдена', 404);
      }
      if (targetClientId && parseOptionalBigInt(dealContext.deal.lead_id) !== targetClientId) {
        throw new AppError('Сделка не принадлежит указанному клиенту', 400);
      }

      const deal = dealContext.deal;
      const contractNumber = deal.contract_number || '';
      const apartment = String(deal.unit_number || deal.units?.unit_number || '');
      const projectName = deal.project_name || deal.units?.floors?.sections?.buildings?.projects?.name || 'ЖК TOZON-PLAZA';

      if (code === 'PAYMENT_REMINDER' || resolvedText.includes('{{payment_amount}}')) {
        if (!dealContext.currency) {
          throw new AppError('Не удалось определить валюту сделки', 400);
        }
        if (!dealContext.nextSchedule) {
          throw new AppError('Для сделки не найден следующий неоплаченный платёж', 400);
        }
        resolvedText = resolvedText.replace(/\{\{\s*payment_amount\s*\}\}/g, dealContext.nextSchedule.paymentAmountFormatted);
        resolvedText = resolvedText.replace(/\{\{\s*payment_date\s*\}\}/g, dealContext.nextSchedule.due_date);
      }

      if (code === 'DEBTOR_REMINDER' || resolvedText.includes('{{overdue_amount}}')) {
        if (!dealContext.currency) {
          throw new AppError('Не удалось определить валюту сделки', 400);
        }
        if (dealContext.overdueMinor <= 0) {
          throw new AppError('У клиента отсутствует подтвержденная просроченная задолженность', 400);
        }
        resolvedText = resolvedText.replace(/\{\{\s*overdue_amount\s*\}\}/g, dealContext.overdueAmountFormatted);
      }

      resolvedText = resolvedText.replace(/\{\{\s*contract_number\s*\}\}/g, contractNumber);
      resolvedText = resolvedText.replace(/\{\{\s*apartment\s*\}\}/g, apartment);
      resolvedText = resolvedText.replace(/\{\{\s*project_name\s*\}\}/g, projectName);
      resolvedText = resolvedText.replace(/\{\{\s*currency\s*\}\}/g, dealContext.currency || '');
    }

    // 5. Final check for remaining unresolved placeholders
    if (/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(resolvedText)) {
      throw new AppError('Сообщение содержит незаполненные переменные шаблона', 400);
    }

    const characterCount = resolvedText.length;
    const isUnicode = /[^\u0000-\u007F]/.test(resolvedText);
    const smsSegments = characterCount > 0
      ? (isUnicode ? (characterCount <= 70 ? 1 : Math.ceil(characterCount / 67)) : (characterCount <= 160 ? 1 : Math.ceil(characterCount / 153)))
      : 0;

    return {
      templateCode: code,
      text: resolvedText,
      characterCount,
      smsSegments,
      encoding: isUnicode ? 'UNICODE' : 'GSM-7',
      resolved: true
    };
  }

  /**
   * Preview template resolution (read-only, no DB insert, no Payom call).
   */
  async previewSms({ templateCode = null, text = null, clientId = null, dealId = null, taskId = null, meetingId = null }) {
    return await this.resolveTemplate({
      templateCode,
      text,
      clientId,
      dealId,
      taskId: taskId || meetingId
    });
  }

  /**
   * Main method to send SMS safely with guaranteed audit trail and fail-closed rules.
   */
  async sendSms({
    clientId = null,
    phone = null,
    text = null,
    templateCode = null,
    dealId = null,
    contractId = null,
    taskId = null,
    meetingId = null,
    userId = null,
    senderName = 'TOZON-PLAZA'
  }) {
    const normClientId = parseOptionalBigInt(clientId);
    const normDealId = parseOptionalBigInt(dealId);
    const normTaskId = parseOptionalBigInt(taskId || meetingId);

    // 1. Resolve template text using unified server-side resolver
    let messageText = text;
    if (templateCode || (text && /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(text))) {
      const resolvedInfo = await this.resolveTemplate({
        templateCode,
        text,
        clientId: normClientId,
        dealId: normDealId,
        taskId: normTaskId
      });
      messageText = resolvedInfo.text;
    }

    let targetPhone = phone;
    let clientName = null;

    if (normClientId) {
      const lead = await LeadsRepository.findById(normClientId);
      if (lead) {
        clientName = lead.full_name;
        if (!targetPhone) {
          targetPhone = lead.phone || lead.secondary_phone;
        }
      } else if (!targetPhone) {
        throw new AppError(`Клиент с ID ${normClientId} не найден`, 404);
      }
    }

    if (normDealId) {
      const deal = await DealsRepository.getDealById(normDealId);
      if (!deal) {
        throw new AppError('Сделка не найдена', 404);
      }
      const dealLeadId = parseOptionalBigInt(deal.lead_id);
      if (normClientId && dealLeadId !== normClientId) {
        throw new AppError('Сделка не принадлежит указанному клиенту', 400);
      }
    }

    if (!targetPhone) {
      throw new AppError('Телефонный номер получателя не указан', 400);
    }

    const normResult = normalizePhoneNumber(targetPhone);
    if (!normResult.isValid) {
      throw new AppError(normResult.error || 'Некорректный телефонный номер', 400);
    }
    const normalizedPhone = normResult.normalized;

    if (!messageText || typeof messageText !== 'string' || !messageText.trim()) {
      throw new AppError('Текст SMS сообщения не может быть пустым', 400);
    }
    const cleanedText = messageText.trim();

    if (/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(cleanedText)) {
      throw new AppError('Сообщение содержит незаполненные переменные шаблона', 400);
    }

    // Create initial queued record in DB FIRST (Audit Trail)
    const dbRecord = await SmsRepository.createMessage({
      clientId: normClientId,
      dealId: normDealId,
      contractId,
      phone: normalizedPhone,
      message: cleanedText,
      provider: 'PAYOM',
      senderName,
      status: 'queued',
      createdBy: userId
    });

    if (!dbRecord || !dbRecord.id) {
      throw new AppError('Не удалось зарегистрировать сообщение в базе данных (Audit Trail error)', 500);
    }

    // 5. Update status to 'sending'
    await SmsRepository.updateMessageStatus(dbRecord.id, { status: 'sending' });

    // 6. Call SMS Provider (Only reached if DB persistence succeeded)
    const providerResult = await this.provider.sendSms({
      phone: normalizedPhone,
      text: cleanedText,
      senderName
    });

    const now = new Date().toISOString();

    // 7. Process provider outcome & update DB record
    if (providerResult.success) {
      await SmsRepository.updateMessageStatus(dbRecord.id, {
        status: 'sent',
        providerMessageId: providerResult.providerMessageId,
        sentAt: now
      });

      const isMock = Boolean(providerResult.isMock);

      return {
        success: true,
        message: isMock ? 'SMS обработано в тестовом режиме (Mock)' : 'SMS успешно отправлено',
        data: {
          id: dbRecord.id,
          clientId,
          clientName,
          phone: normalizedPhone,
          message: cleanedText,
          senderName,
          status: 'sent',
          providerMessageId: providerResult.providerMessageId,
          isMock,
          sentAt: now
        }
      };
    } else {
      await SmsRepository.updateMessageStatus(dbRecord.id, {
        status: 'failed',
        errorCode: providerResult.errorCode,
        errorMessage: providerResult.errorMessage
      });

      return {
        success: false,
        error: {
          code: providerResult.errorCode || 'SMS_SEND_FAILED',
          message: providerResult.errorMessage || 'Не удалось отправить SMS'
        },
        data: {
          id: dbRecord.id,
          phone: normalizedPhone,
          status: 'failed'
        }
      };
    }
  }

  /**
   * Fetch SMS dispatch history.
   */
  async getHistory(filters = {}, user = null) {
    return await SmsRepository.getHistory(filters, user);
  }

  /**
   * Fetch message templates.
   */
  async getTemplates() {
    return await SmsRepository.getTemplates();
  }
}

export const defaultSmsService = new SmsService();
