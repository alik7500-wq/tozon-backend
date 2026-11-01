import express from 'express';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { SalesAutomationDetector } from './salesAutomationDetector.js';
import { isWithinSalesAutomationWindow, getBusinessDateTime } from '../../utils/businessTime.js';

const router = express.Router();

// Mock store / settings for local & cloud MVP
let automationSettings = {
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
    status: 'NOT_CONFIGURED',
    lastTestAt: null
  },
  whatsapp: {
    enabled: false,
    provider: 'Green-API / WABA',
    instanceId: '',
    apiToken: '',
    status: 'NOT_CONFIGURED',
    lastTestAt: null
  },
  sms: {
    enabled: false,
    provider: 'OsonSMS / Babilon-T',
    apiKey: '',
    senderId: 'TOZON',
    balance: 'Не проверен',
    status: 'NOT_CONFIGURED',
    lastTestAt: null
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

let dispatchLogs = [];

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

// Explicitly disable the old mock send endpoint until a real provider is integrated.
router.post('/test-send', protect, (_req, res) => {
  return res.status(501).json({
    status: 'error',
    code: 'PROVIDER_NOT_CONFIGURED',
    message: 'Реальная отправка через этот канал пока не настроена. Тестовое сообщение не отправлялось.'
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

// POST /api/automation/run-detector
router.post('/run-detector', async (req, res) => {
  try {
    const cronSecret = process.env.SALES_AUTOMATION_CRON_SECRET || 'TOZON_SALES_AUTOMATION_SECRET_2026';
    const providedSecret = req.headers['x-cron-secret'] || (req.headers.authorization ? req.headers.authorization.replace('Bearer ', '').trim() : null);

    if (!providedSecret || providedSecret !== cronSecret) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED_CRON_SECRET',
          message: 'Доступ запрещен: требуется действительный секрет авторизации служб Cron.'
        }
      });
    }

    const isDryRun = req.query.dryRun === 'true' || req.body?.isDryRun === true || req.body?.dryRun === true;
    const isFeatureEnabled = process.env.SALES_AUTOMATION_ENABLED !== undefined ? process.env.SALES_AUTOMATION_ENABLED === 'true' : true;

    if (!isFeatureEnabled && !isDryRun) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'SALES_AUTOMATION_DISABLED',
          message: 'Модуль Sales Automation отключен флагом SALES_AUTOMATION_ENABLED=false. Живое создание уведомлений заблокировано.'
        }
      });
    }

    const businessDate = req.query.businessDate || req.body?.businessDate || null;
    const effectiveDryRun = isDryRun || !isFeatureEnabled;

    // Safe Working Hours Window Enforcement (08:00 - 20:00 Asia/Dushanbe inclusive)
    // Allows 20:00 run (up to 20:05 for container startup), but strictly excludes 20:30 (15:30 UTC) or nighttime.
    const enforceWindow = req.query.enforceWindow !== 'false' && req.body?.enforceWindow !== false && !isDryRun;
    if (enforceWindow && !isWithinSalesAutomationWindow()) {
      const bdt = getBusinessDateTime();
      return res.json({
        success: true,
        skipped: true,
        reason: 'OUTSIDE_WORKING_HOURS',
        message: `Вызов пропущен: текущее время (${bdt.timeStr} Asia/Dushanbe) находится вне рабочего окна 08:00–20:00 включительно.`,
        dushanbeTime: bdt.timeStr
      });
    }

    const stats = await SalesAutomationDetector.runDetectionCycle({
      businessDate,
      isDryRun: effectiveDryRun
    });

    return res.json({
      success: true,
      data: {
        featureEnabled: isFeatureEnabled,
        effectiveDryRun,
        stats
      }
    });
  } catch (err) {
    console.error('[AutomationRouter] Error running sales automation detector:', err);
    return res.status(500).json({
      success: false,
      error: {
        code: 'DETECTOR_EXECUTION_ERROR',
        message: err.message || 'Ошибка выполнения детектора Sales Automation'
      }
    });
  }
});

export { router as automationRouter };
