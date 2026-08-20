import express from 'express';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';

const router = express.Router();

// Mock store / settings for local & cloud MVP
let automationSettings = {
  telegram: {
    enabled: true,
    botToken: '7182938491:AAHkL...SAMPLE_TOKEN',
    chatId: '-100293848123',
    status: 'CONNECTED',
    lastTestAt: new Date().toISOString()
  },
  whatsapp: {
    enabled: true,
    provider: 'Green-API / WABA',
    instanceId: '1101829384',
    apiToken: 'd8a9f0b1c2d3...TOKEN',
    status: 'ACTIVE',
    lastTestAt: new Date().toISOString()
  },
  sms: {
    enabled: true,
    provider: 'OsonSMS / Babilon-T',
    apiKey: 'oson_live_8912384912',
    senderId: 'TOZON',
    balance: '480 SMS',
    status: 'ACTIVE',
    lastTestAt: new Date().toISOString()
  }
};

let automationRules = [
  {
    id: 1,
    name: 'Мгновенное уведомление о новом лиде',
    eventType: 'LEAD_CREATED',
    channel: 'TELEGRAM',
    recipient: 'MANAGER_GROUP',
    delayMinutes: 0,
    isActive: true,
    template: '🔥 Новый лид в CRM!\nИмя: {{customerName}}\nТелефон: {{phone}}\nОбъект: {{projectName}}'
  },
  {
    id: 2,
    name: 'Напоминание о плановом платеже за 3 дня',
    eventType: 'PAYMENT_DUE_SOON',
    channel: 'WHATSAPP',
    recipient: 'CUSTOMER',
    delayMinutes: 0,
    isActive: true,
    template: 'Уважаемый(ая) {{customerName}}, напоминаем, что {{dueDate}} наступает срок очередного взноса {{amount}} по договору {{contractNumber}} (ЖК {{projectName}}).'
  },
  {
    id: 3,
    name: 'Электронный чек при поступлении оплаты',
    eventType: 'PAYMENT_RECEIVED',
    channel: 'SMS',
    recipient: 'CUSTOMER',
    delayMinutes: 0,
    isActive: true,
    template: 'TOZON CRM: По договору {{contractNumber}} принята оплата {{amount}}. Остаток долга: {{remainingDebt}}. Спасибо!'
  },
  {
    id: 4,
    name: 'Оповещение о просрочке платежа',
    eventType: 'PAYMENT_OVERDUE',
    channel: 'WHATSAPP',
    recipient: 'CUSTOMER',
    delayMinutes: 60,
    isActive: true,
    template: 'Здравствуйте, {{customerName}}! По договору {{contractNumber}} имеется просроченный взнос {{amount}}. Просим связаться с финансовым отделом Tozon.'
  },
  {
    id: 5,
    name: 'Истечение срока брони квартиры',
    eventType: 'RESERVATION_EXPIRING',
    channel: 'TELEGRAM',
    recipient: 'RESPONSIBLE_USER',
    delayMinutes: 0,
    isActive: true,
    template: '⚠️ Внимание! Истекает срок бронирования квартиры №{{unitNumber}} в ЖК {{projectName}} (Клиент: {{customerName}}).'
  }
];

let dispatchLogs = [
  {
    id: 1,
    channel: 'TELEGRAM',
    recipient: 'Отдел продаж (Группа Telegram)',
    event: 'LEAD_CREATED',
    message: '🔥 Новый лид в CRM! Имя: Алиев Рахим, Тел: +9929110106666, Объект: ЖК TOZON PLAZA',
    status: 'DELIVERED',
    sentAt: new Date(Date.now() - 15 * 60000).toISOString()
  },
  {
    id: 2,
    channel: 'SMS',
    recipient: '+992 92 777 9757',
    event: 'PAYMENT_RECEIVED',
    message: 'TOZON CRM: По договору 25601-2026-0004 принята оплата 10,000 USD. Спасибо!',
    status: 'DELIVERED',
    sentAt: new Date(Date.now() - 60 * 60000).toISOString()
  },
  {
    id: 3,
    channel: 'WHATSAPP',
    recipient: '+992 93 555 1234',
    event: 'PAYMENT_DUE_SOON',
    message: 'Уважаемый(ая) Шахноза Алиева, напоминаем о сроке платежа 1,500 USD по договору 25601-2026-0002.',
    status: 'DELIVERED',
    sentAt: new Date(Date.now() - 180 * 60000).toISOString()
  }
];

// GET /api/automation/settings
router.get('/settings', protect, (req, res) => {
  res.json({
    status: 'success',
    data: {
      settings: automationSettings,
      rules: automationRules,
      logs: dispatchLogs
    }
  });
});

// POST /api/automation/settings
router.post('/settings', protect, (req, res) => {
  if (req.body.settings) {
    automationSettings = { ...automationSettings, ...req.body.settings };
  }
  if (req.body.rules) {
    automationRules = req.body.rules;
  }
  res.json({
    status: 'success',
    data: {
      settings: automationSettings,
      rules: automationRules
    }
  });
});

// POST /api/automation/test-send
router.post('/test-send', protect, (req, res) => {
  const { channel, recipient, message } = req.body;
  
  const newLog = {
    id: Date.now(),
    channel: channel || 'TELEGRAM',
    recipient: recipient || 'Тестовый получатель',
    event: 'MANUAL_TEST',
    message: message || 'Тестовое уведомление из Tozon CRM',
    status: 'DELIVERED',
    sentAt: new Date().toISOString()
  };

  dispatchLogs.unshift(newLog);

  res.json({
    status: 'success',
    message: `Тестовое сообщение успешно отправлено через ${channel}!`,
    data: { log: newLog }
  });
});

// PATCH /api/automation/rules/:id/toggle
router.patch('/rules/:id/toggle', protect, (req, res) => {
  const ruleId = parseInt(req.params.id, 10);
  const rule = automationRules.find(r => r.id === ruleId);
  if (rule) {
    rule.isActive = !rule.isActive;
    return res.json({ status: 'success', data: { rule } });
  }
  res.status(404).json({ status: 'error', message: 'Правило не найдено' });
});

export { router as automationRouter };
