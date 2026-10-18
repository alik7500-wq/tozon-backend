import express from 'express';
import crypto from 'crypto';
import { LeadsRepository } from './leads.repository.js';
import { TasksService } from '../tasks/tasks.service.js';
import { ManagerPerformanceService } from '../reports/managerPerformance.service.js';
import { RoundRobinService } from './roundRobin.service.js';
import { DistributionSettingsService } from './distributionSettings.service.js';
import { AlternativeUnitsService } from '../inventory/alternativeUnits.service.js';
import { protect, protectOptional } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';

const router = express.Router();

/**
 * Public Webhook for external websites, landing pages, Telegram bots and Social Ads (Instagram / Facebook / WhatsApp).
 * Features:
 * - Decoupled from hardcoded user 1 (assigns to common pool by default)
 * - Fail-secure secret verification (requires WEBHOOK_SECRET)
 * - Multi-channel authentication: headers (x-webhook-secret, Bearer), body (secret/token for Tilda), query (?secret= for legacy), CRM admin session
 * - Timing-safe secret comparison (crypto.timingSafeEqual)
 * - Deduplication by Idempotency-Key header or body field
 * - Deduplication by phone number within 10-minute window
 * - Repeat inquiries routing for active existing clients
 */
router.post('/webhook', protectOptional, async (req, res, next) => {
  try {
    // 1. Webhook Authentication
    const configuredSecret = process.env.WEBHOOK_SECRET;
    const isCrmAdminSession = Boolean(req.user && ['ADMIN', 'DIRECTOR'].includes(req.user.role));

    if (!isCrmAdminSession) {
      if (!configuredSecret) {
        return next(new AppError('Интеграция вебхука временно отключена: WEBHOOK_SECRET не настроен на сервере', 503));
      }

      const incomingSecret = req.headers['x-webhook-secret']
        || req.headers['x-telegram-bot-api-secret-token']
        || (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : null)
        || req.body?.secret
        || req.body?.token
        || req.query?.secret
        || req.query?.token;

      if (!incomingSecret) {
        return next(new AppError('Неверный или отсутствующий ключ аутентификации webhook', 401));
      }

      const bufIncoming = Buffer.from(String(incomingSecret));
      const bufConfigured = Buffer.from(String(configuredSecret));
      if (bufIncoming.length !== bufConfigured.length || !crypto.timingSafeEqual(bufIncoming, bufConfigured)) {
        return next(new AppError('Неверный или отсутствующий ключ аутентификации webhook', 401));
      }
    }

    const { full_name, phone, secondary_phone, source, notes, project_name, rooms, budget } = req.body;

    if (!full_name || !phone) {
      return next(new AppError('Поля ФИО (full_name) и Телефон (phone) обязательны', 400));
    }

    // 2. Deduplication check via Idempotency-Key
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotency_key;
    if (idempotencyKey) {
      const existingByKey = await LeadsRepository.findByIdempotencyKey(idempotencyKey);
      if (existingByKey) {
        return res.status(200).json({
          status: 'success',
          message: 'Заявка уже зарегистрирована (дубликат предотвращен по ключу идемпотентности)',
          data: {
            leadId: existingByKey.id,
            client: existingByKey.full_name,
            status: existingByKey.status,
            duplicate: true
          }
        });
      }
    }

    // 3. Deduplication check by phone in 10-minute window
    const recentByPhone = await LeadsRepository.findRecentByPhone(phone, 10);
    if (recentByPhone) {
      return res.status(200).json({
        status: 'success',
        message: 'Заявка с этого номера уже получена недавно (дубликат предотвращен)',
        data: {
          leadId: recentByPhone.id,
          client: recentByPhone.full_name,
          status: recentByPhone.status,
          duplicate: true
        }
      });
    }

    // 4. Repeat inquiry check for existing active clients
    const existingActive = await LeadsRepository.findActiveByPhone(phone);
    if (existingActive) {
      const noteText = `[Повторное обращение] Заявка из источника ${source || 'Сайт'}: ${notes || 'Повторный интерес к проекту'}`;
      await LeadsRepository.addNote(existingActive.id, existingActive.responsible_user_id || 1, noteText);
      if (existingActive.responsible_user_id) {
        TasksService.onRepeatInquiry(existingActive, existingActive.responsible_user_id, source).catch(err => {
          console.warn('Failed to dispatch repeat inquiry task:', err);
        });
      }
      return res.status(200).json({
        status: 'success',
        message: 'Повторное обращение зарегистрировано в карточке существующего клиента',
        data: {
          leadId: existingActive.id,
          client: existingActive.full_name,
          status: existingActive.status,
          responsible_user_id: existingActive.responsible_user_id,
          repeat_inquiry: true
        }
      });
    }

    // 5. Distribution engine resolution (Round-robin if enabled; pool by default)
    const distribution = await RoundRobinService.resolveAssignment();

    let lead;
    try {
      const leadPayload = {
        full_name,
        phone,
        secondary_phone: secondary_phone || null,
        source: source || 'WEBSITE',
        status: 'NEW',
        notes: notes || `Заявка с онлайн-источника (${source || 'Сайт'}).`,
        responsible_user_id: distribution.responsible_user_id || null,
        assigned_at: distribution.assigned_at || null,
        idempotency_key: idempotencyKey || null
      };

      lead = await LeadsRepository.create(leadPayload);
    } finally {
      if (typeof distribution?.releaseSlot === 'function') {
        distribution.releaseSlot();
      }
    }

    // If distributed to an active manager, trigger manager call task
    if (lead.responsible_user_id) {
      await TasksService.onLeadCreated(lead, lead.responsible_user_id);
    }

    res.status(201).json({
      status: 'success',
      message: lead.responsible_user_id
        ? 'Заявка успешно принята и назначена менеджеру'
        : 'Заявка успешно принята в общий пул',
      data: {
        leadId: lead.id,
        client: lead.full_name,
        status: lead.status,
        responsible_user_id: lead.responsible_user_id,
        pool: !lead.responsible_user_id
      }
    });
  } catch (error) {
    next(error);
  }
});

// Protect all internal CRM endpoints
router.use(protect);

// Strict RBAC: WAREHOUSE_MANAGER has zero access to leads
router.use((req, res, next) => {
  if (req.user?.role === 'WAREHOUSE_MANAGER') {
    return next(new AppError('Доступ к лидам запрещен для данной роли', 403));
  }
  next();
});

// GET /api/leads/performance - Manager Performance & Sales KPI analytics
router.get('/performance', async (req, res, next) => {
  try {
    const filters = {
      period: req.query.period,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      managerId: req.query.managerId,
      projectId: req.query.projectId
    };
    const data = await ManagerPerformanceService.getPerformanceData(filters, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) { next(error); }
});

// GET /api/leads/sla-control - SLA & processing control dashboard
router.get('/sla-control', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search,
      slaStatus: req.query.slaStatus || req.query.status,
      projectId: parseOptionalBigInt(req.query.projectId),
      responsibleUserId: parseOptionalBigInt(req.query.responsibleUserId),
      page: req.query.page,
      limit: req.query.limit
    };
    const result = await LeadsRepository.getSlaControlData(filters, req.user);
    res.status(200).json({ status: 'success', data: result });
  } catch (error) { next(error); }
});

// GET /api/leads/stats - Summary KPI statistics for 7 clickable metric cards
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await LeadsRepository.getPoolStats(req.user);
    res.status(200).json({ status: 'success', data: { stats } });
  } catch (error) { next(error); }
});

// GET /api/leads/distribution/settings - Get automated distribution configuration
router.get('/distribution/settings', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ запрещен', 403));
    }
    const settings = await DistributionSettingsService.getSettings();
    const eligibleReps = await RoundRobinService.getEligibleReps();
    res.status(200).json({ status: 'success', data: { settings, eligibleReps } });
  } catch (error) { next(error); }
});

// POST /api/leads/distribution/settings - Update automated distribution configuration (ADMIN & DIRECTOR only)
router.post('/distribution/settings', async (req, res, next) => {
  try {
    if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) {
      return next(new AppError('Управление авто-распределением доступно только руководителю или администратору', 403));
    }
    const updated = await DistributionSettingsService.updateSettings(req.body, req.user);
    res.status(200).json({ status: 'success', data: { settings: updated } });
  } catch (error) { next(error); }
});

// GET /api/leads/winback/opportunities - Leads whose interested units became SOLD/RESERVED with available alternatives
router.get('/winback/opportunities', async (req, res, next) => {
  try {
    const opportunities = await AlternativeUnitsService.getWinBackOpportunities(req.user);
    res.status(200).json({ status: 'success', data: { opportunities } });
  } catch (error) { next(error); }
});

// GET /api/leads - Lead listing with RBAC, quick filters, and SLA indicators
router.get('/', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      quickFilter: req.query.quickFilter,
      unassigned: req.query.unassigned === 'true',
      projectId: parseOptionalBigInt(req.query.projectId),
      responsibleUserId: parseOptionalBigInt(req.query.responsibleUserId)
    };

    // RBAC: SALES_MANAGER is strictly restricted to viewing only their own assigned leads
    if (req.user?.role === 'SALES_MANAGER') {
      filters.responsibleUserId = req.user.id;
      filters.unassigned = false;
      // Cannot inspect unassigned pool
      if (req.query.unassigned === 'true' || filters.quickFilter === 'UNASSIGNED') {
        return res.status(200).json({ status: 'success', data: { leads: [] } });
      }
    }

    const leads = await LeadsRepository.findAll(filters);
    res.status(200).json({ status: 'success', data: { leads } });
  } catch (error) { next(error); }
});

// GET /api/leads/:id - Single lead details with assignment history and SLA breakdown
router.get('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const lead = await LeadsRepository.findById(cleanId);
    if (!lead) return next(new AppError('Лид не найден', 404));

    // RBAC: SALES_MANAGER can only inspect their own leads
    if (req.user?.role === 'SALES_MANAGER' && lead.responsible_user_id && Number(lead.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к просмотру лидов других менеджеров', 403));
    }
    // SALES_MANAGER cannot inspect unassigned pool leads unless authorized
    if (req.user?.role === 'SALES_MANAGER' && !lead.responsible_user_id) {
      return next(new AppError('У вас нет доступа к просмотру неназначенных заявок из общего пула', 403));
    }

    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

// POST /api/leads - Create new lead
router.post('/', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ к созданию лидов запрещен для данной роли', 403));
    }

    const payload = { ...req.body };
    // RBAC IDOR protection: SALES_MANAGER can ONLY create leads assigned to themselves
    if (req.user?.role === 'SALES_MANAGER') {
      payload.responsible_user_id = req.user.id;
    }

    const lead = await LeadsRepository.create(payload);

    if (lead.responsible_user_id) {
      await TasksService.onLeadCreated(lead, parseOptionalBigInt(req.user.id) || 1);
    }

    res.status(201).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

// PATCH /api/leads/:id/assign - Manual manager assignment & pool management (Stage 4)
router.patch('/:id/assign', async (req, res, next) => {
  try {
    // Only ADMIN and DIRECTOR can reassign leads
    if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) {
      return next(new AppError('Назначение и переназначение менеджера разрешено только руководителю или администратору', 403));
    }

    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const { responsible_user_id, reason } = req.body;

    const lead = await LeadsRepository.assignManager(
      cleanId,
      responsible_user_id,
      reason,
      req.user.id
    );

    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

// POST /api/leads/:id/first-contact - Record first-contact outcome (Stage 5 SLA)
router.post('/:id/first-contact', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ запрещен', 403));
    }

    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (req.user?.role === 'SALES_MANAGER' && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к фиксации контакта по лидам других менеджеров', 403));
    }

    const lead = await LeadsRepository.recordFirstContact(cleanId, req.user.id, req.body);
    await TasksService.onFirstContactOutcome(lead, req.body?.outcome, req.body, req.user.id);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

// GET /api/leads/:id/alternative-units - Alternative apartment recommendations for unavailable interested units
router.get('/:id/alternative-units', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ запрещен', 403));
    }

    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (req.user?.role === 'SALES_MANAGER' && existing.responsible_user_id && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к лидам других менеджеров', 403));
    }

    const data = await AlternativeUnitsService.getAlternativeUnitsForLead(cleanId);
    res.status(200).json({ status: 'success', data });
  } catch (error) { next(error); }
});

// PUT /api/leads/:id - Update lead details
router.put('/:id', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ к редактированию лидов запрещен для данной роли', 403));
    }

    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (req.user?.role === 'SALES_MANAGER' && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к редактированию лидов других менеджеров или общего пула', 403));
    }

    if (req.body.responsible_user_id !== undefined && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
      return next(new AppError('Переназначение ответственного менеджера разрешено только руководителю или администратору', 403));
    }

    // If reassigning manager, use assignManager for full audit and validation
    if (req.body.responsible_user_id !== undefined && req.body.responsible_user_id !== existing.responsible_user_id) {
      await LeadsRepository.assignManager(cleanId, req.body.responsible_user_id, req.body.reassignment_reason, req.user.id);
    }

    const updatePayload = { ...req.body };
    delete updatePayload.first_contact_at;
    delete updatePayload.first_contact_outcome;
    delete updatePayload.first_contact_by_user_id;
    delete updatePayload.assigned_at;
    delete updatePayload.idempotency_key;

    const lead = await LeadsRepository.update(cleanId, updatePayload);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

// PATCH /api/leads/:id - Partial update
router.patch('/:id', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ к редактированию лидов запрещен для данной роли', 403));
    }

    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (req.user?.role === 'SALES_MANAGER' && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к редактированию лидов других менеджеров или общего пула', 403));
    }

    if (req.body.responsible_user_id !== undefined && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
      return next(new AppError('Переназначение ответственного менеджера разрешено только руководителю или администратору', 403));
    }

    if (req.body.responsible_user_id !== undefined && req.body.responsible_user_id !== existing.responsible_user_id) {
      await LeadsRepository.assignManager(cleanId, req.body.responsible_user_id, req.body.reassignment_reason, req.user.id);
    }

    const updatePayload = { ...req.body };
    delete updatePayload.first_contact_at;
    delete updatePayload.first_contact_outcome;
    delete updatePayload.first_contact_by_user_id;
    delete updatePayload.assigned_at;
    delete updatePayload.idempotency_key;

    const lead = await LeadsRepository.update(cleanId, updatePayload);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

// PATCH /api/leads/:id/status - Status change
router.patch('/:id/status', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ к изменению статуса лидов запрещен для данной роли', 403));
    }

    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (req.user?.role === 'SALES_MANAGER' && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к изменению статуса лидов других менеджеров или общего пула', 403));
    }

    const lead = await LeadsRepository.updateStatus(
      cleanId,
      req.body.status,
      req.body.lost_reason,
      req.body.comment,
      parseOptionalBigInt(req.user?.id)
    );

    // Auto-generate task on status change
    await TasksService.onLeadStatusChanged(lead, req.body.status, parseOptionalBigInt(req.user.id) || 1);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

// POST /api/leads/:id/notes - Add note
router.post('/:id/notes', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (req.user?.role === 'SALES_MANAGER' && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к лидам других менеджеров или общему пулу', 403));
    }

    const note = await LeadsRepository.addNote(cleanId, parseOptionalBigInt(req.user.id) || 1, req.body.body);
    res.status(201).json({ status: 'success', data: { note } });
  } catch (error) { next(error); }
});

// DELETE /api/leads/:id - Archive lead
router.delete('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (['SALES_MANAGER', 'MANAGER'].includes(req.user?.role) && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к удалению лидов других менеджеров или общего пула', 403));
    }

    await LeadsRepository.archive(cleanId);
    res.status(204).json({ status: 'success', data: null });
  } catch (error) { next(error); }
});

// GET /api/leads/:id/interested-units - List shortlisted apartments for a lead
router.get('/:id/interested-units', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (['SALES_MANAGER', 'MANAGER'].includes(req.user?.role) && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к просмотру лидов других менеджеров', 403));
    }

    const interests = await LeadsRepository.getInterestedUnits(cleanId);
    res.status(200).json({ status: 'success', data: { interests } });
  } catch (error) { next(error); }
});

// POST /api/leads/:id/interested-units - Save interested apartment for a lead
router.post('/:id/interested-units', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ к редактированию интересов лида запрещен для данной роли', 403));
    }

    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (['SALES_MANAGER', 'MANAGER'].includes(req.user?.role) && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к сохранению интересов по лидам других менеджеров', 403));
    }

    const { unit_id, priority, comment, next_contact_date } = req.body;
    if (!unit_id) {
      return next(new AppError('Поле unit_id обязательно для сохранения интереса к квартире', 400));
    }

    const result = await LeadsRepository.addInterestedUnit(cleanId, { unit_id, priority, comment, next_contact_date }, req.user);
    res.status(201).json({ status: 'success', data: result });
  } catch (error) { next(error); }
});

// DELETE /api/leads/:id/interested-units/:unitId - Remove interested apartment from a lead
router.delete('/:id/interested-units/:unitId', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ запрещен для данной роли', 403));
    }

    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const cleanUnitId = parseRequiredBigInt(req.params.unitId, 'unitId');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));

    if (['SALES_MANAGER', 'MANAGER'].includes(req.user?.role) && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к редактированию интересов по лидам других менеджеров', 403));
    }

    await LeadsRepository.removeInterestedUnit(cleanId, cleanUnitId, req.user);
    res.status(200).json({ status: 'success', message: 'Квартира удалена из интересов клиента' });
  } catch (error) { next(error); }
});

export default router;
