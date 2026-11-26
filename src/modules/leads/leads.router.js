import express from 'express';
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { LeadsRepository } from './leads.repository.js';
import { MAX_EXPORT_ROWS } from './leadFilterValidator.js';
import { TasksService } from '../tasks/tasks.service.js';
import { ManagerPerformanceService } from '../reports/managerPerformance.service.js';
import { RoundRobinService } from './roundRobin.service.js';
import { DistributionSettingsService } from './distributionSettings.service.js';
import { AlternativeUnitsService } from '../inventory/alternativeUnits.service.js';
import { protect, protectOptional } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';
import { CANONICAL_STAGES, LOST_REASONS, buildLeadAccessScope } from './leadDomain.js';

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

// GET /api/leads/stages - Canonical stages and lost reasons (F-01)
router.get('/stages', (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      stages: CANONICAL_STAGES,
      lostReasons: LOST_REASONS
    }
  });
});

// GET /api/leads/updates - Cursor-based incremental updates with RBAC (N-01)
router.get('/updates', async (req, res, next) => {
  try {
    const scope = buildLeadAccessScope(req.user, {
      projectId: parseOptionalBigInt(req.query.projectId),
      managerId: req.query.managerId
    });
    const all = await LeadsRepository.findAll(scope.effectiveFilters);
    const since = req.query.since ? new Date(req.query.since).getTime() : 0;
    const updated = Number.isFinite(since) && since > 0
      ? all.filter((l) => new Date(l.updated_at || l.created_at).getTime() > since)
      : all.slice(0, 50);

    res.status(200).json({
      status: 'success',
      data: {
        leads: updated,
        cursor: new Date().toISOString(),
        scope: { role: scope.role, restrictedToSelf: scope.restrictedToSelf }
      }
    });
  } catch (error) { next(error); }
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

// GET /api/leads/stats - Summary KPI statistics using unified filters & RBAC (R04)
router.get('/stats', async (req, res, next) => {
  try {
    const result = await LeadsRepository.queryUnified({ ...req.query, limit: '0' }, req.user);
    res.status(200).json({
      status: 'success',
      data: {
        stats: result.stats,
        stageCounts: result.stageCounts,
        total: result.total,
        appliedFilters: result.appliedFilters,
        scope: result.scope,
        generatedAt: result.generatedAt
      }
    });
  } catch (error) { next(error); }
});

// GET /api/leads/board - Independent per-column board chunked loading with unified filters & RBAC scope (R04.1)
router.get('/board', async (req, res, next) => {
  try {
    const { perStageLimit, ...restQuery } = req.query || {};
    const result = await LeadsRepository.queryUnified(
      { ...restQuery, limit: '0', boardPerStageLimit: perStageLimit || restQuery.boardPerStageLimit || '20' },
      req.user
    );
    res.status(200).json({
      status: 'success',
      data: {
        boardColumns: result.boardColumns || {},
        stageCounts: result.stageCounts,
        stats: result.stats,
        total: result.total,
        appliedFilters: result.appliedFilters,
        scope: result.scope,
        generatedAt: result.generatedAt
      }
    });
  } catch (error) { next(error); }
});

// GET /api/leads/export - Streaming export (.xlsx default, optional ?format=csv) with unified filter & RBAC scope (R04.1)
router.get('/export', async (req, res, next) => {
  try {
    const { format: rawFormat, ...filterQuery } = req.query || {};
    const format = String(rawFormat || 'xlsx').toLowerCase();
    if (format !== 'xlsx' && format !== 'csv') {
      return next(new AppError(`Неподдерживаемый формат экспорта: ${rawFormat}. Используйте xlsx или csv`, 400));
    }

    const firstPage = await LeadsRepository.queryUnified({ ...filterQuery, limit: '500' }, req.user);
    const expectedTotal = Number(firstPage.total || 0);

    if (expectedTotal > MAX_EXPORT_ROWS) {
      return res.status(413).json({
        status: 'error',
        code: 'EXPORT_LIMIT_EXCEEDED',
        message: `Выборка содержит ${expectedTotal} записей, что превышает лимит экспорта (${MAX_EXPORT_ROWS}). Уточните фильтры.`
      });
    }

    const header = ['ID', 'ФИО', 'Телефон', 'Этап', 'Источник', 'Проект', 'Менеджер', 'Создан'];
    const mapLeadToRow = (l) => [
      l.id_str || String(l.id ?? ''),
      l.full_name || '',
      l.phone || '',
      l.stage || '',
      l.source_code || l.source || '',
      l.interested_project_name || '',
      l.responsible_user_name || '',
      l.created_at_iso_us || l.created_at || ''
    ];

    res.setHeader('X-Export-Expected-Count', String(expectedTotal));

    let exportedCount = 0;

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="leads-export.csv"');
      const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
      res.write('\uFEFF' + header.map(escapeCsv).join(';') + '\r\n');

      let page = firstPage;
      let cursor = page.nextCursor;
      while (true) {
        if (page.leads.length > 0) {
          const chunk = page.leads.map((l) => mapLeadToRow(l).map(escapeCsv).join(';')).join('\r\n') + '\r\n';
          res.write(chunk);
          exportedCount += page.leads.length;
        }
        if (!cursor) break;
        const prevCursor = cursor;
        page = await LeadsRepository.queryUnified({ ...filterQuery, limit: '500', cursor }, req.user);
        cursor = page.nextCursor;
        if (cursor && cursor === prevCursor) {
          throw new Error('Detected non-advancing cursor during export');
        }
      }
      if (exportedCount !== expectedTotal) {
        res.destroy(new Error(`Export count mismatch: expected ${expectedTotal}, exported ${exportedCount}`));
        return;
      }
      res.end();
      return;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="leads-export.xlsx"');

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: false });
    const sheet = workbook.addWorksheet('Лиды');
    sheet.addRow(header).commit();

    let page = firstPage;
    let cursor = page.nextCursor;
    while (true) {
      for (const l of page.leads) {
        sheet.addRow(mapLeadToRow(l)).commit();
        exportedCount += 1;
      }
      if (!cursor) break;
      const prevCursor = cursor;
      page = await LeadsRepository.queryUnified({ ...filterQuery, limit: '500', cursor }, req.user);
      cursor = page.nextCursor;
      if (cursor && cursor === prevCursor) {
        throw new Error('Detected non-advancing cursor during export');
      }
    }

    if (exportedCount !== expectedTotal) {
      res.destroy(new Error(`Export count mismatch: expected ${expectedTotal}, exported ${exportedCount}`));
      return;
    }

    await workbook.commit();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    next(error);
  }
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

// GET /api/leads - Unified DB-side filtering, total, stageCounts, and keyset cursor (R04)
router.get('/', async (req, res, next) => {
  try {
    const result = await LeadsRepository.queryUnified(req.query, req.user);
    res.status(200).json({ status: 'success', data: result });
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

// PATCH /api/leads/:id/assign - Manual manager assignment & pool management (CAS 409)
router.patch('/:id/assign', async (req, res, next) => {
  try {
    // Only ADMIN and DIRECTOR can reassign leads
    if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) {
      return next(new AppError('Назначение и переназначение менеджера разрешено только руководителю или администратору', 403));
    }

    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const { responsible_user_id, reason, version } = req.body;

    const lead = await LeadsRepository.assignManager(
      cleanId,
      responsible_user_id,
      reason,
      req.user.id,
      true,
      version
    );

    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) {
    if (error?.statusCode === 409 && error.current) {
      return res.status(409).json({ status: 'error', code: 'VERSION_CONFLICT', message: error.message, data: { current: error.current } });
    }
    next(error);
  }
});

// POST /api/leads/:id/communications - Record call, meeting, showing or message outcome (F-12)
router.post('/:id/communications', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ запрещен', 403));
    }
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));
    if (req.user?.role === 'SALES_MANAGER' && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к лидам других менеджеров', 403));
    }

    const lead = await LeadsRepository.recordFirstContact(cleanId, req.user.id, req.body);
    if (req.body?.outcome) {
      await TasksService.onFirstContactOutcome(lead, req.body.outcome, req.body, req.user.id);
    }
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

// POST /api/leads/:id/pause - Set explicit next-action pause with reason (F-13)
router.post('/:id/pause', async (req, res, next) => {
  try {
    if (req.user?.role === 'FINANCE_MANAGER') {
      return next(new AppError('Доступ запрещен', 403));
    }
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));
    if (req.user?.role === 'SALES_MANAGER' && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к лидам других менеджеров', 403));
    }
    const lead = await LeadsRepository.setPause(cleanId, req.user.id, req.body);
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

// Shared profile update handler for PUT/PATCH /api/leads/:id (no direct stage/status/owner bypass)
async function handleLeadProfileUpdate(req, res, next) {
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

    if (req.body.status !== undefined || req.body.stage !== undefined) {
      return next(new AppError('Прямое изменение статуса/этапа через PUT/PATCH запрещено. Используйте PATCH /api/leads/:id/status', 400));
    }

    if (req.body.responsible_user_id !== undefined && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
      return next(new AppError('Переназначение ответственного менеджера разрешено только руководителю или администратору', 403));
    }

    // If reassigning manager, use atomic assignManager ONLY (never re-write responsible_user_id via update)
    let assignedLead = null;
    if (req.body.responsible_user_id !== undefined && req.body.responsible_user_id !== existing.responsible_user_id) {
      assignedLead = await LeadsRepository.assignManager(
        cleanId,
        req.body.responsible_user_id,
        req.body.reassignment_reason,
        req.user.id,
        true,
        req.body.version
      );
    }

    const updatePayload = { ...req.body };
    delete updatePayload.responsible_user_id;
    delete updatePayload.reassignment_reason;
    delete updatePayload.version;
    delete updatePayload.first_contact_at;
    delete updatePayload.first_contact_outcome;
    delete updatePayload.first_contact_by_user_id;
    delete updatePayload.assigned_at;
    delete updatePayload.idempotency_key;

    const lead = await LeadsRepository.update(cleanId, updatePayload);
    res.status(200).json({ status: 'success', data: { lead: lead || assignedLead } });
  } catch (error) {
    if (error?.statusCode === 409 && error.current) {
      return res.status(409).json({ status: 'error', code: error.code || 'VERSION_CONFLICT', message: error.message, data: { current: error.current } });
    }
    next(error);
  }
}

// PUT /api/leads/:id - Update lead profile details
router.put('/:id', handleLeadProfileUpdate);

// PATCH /api/leads/:id - Partial profile update
router.patch('/:id', handleLeadProfileUpdate);

// PATCH /api/leads/:id/status - Atomic stage transition (effects dispatched via durable outbox)
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

    const nextStage = req.body.stage || req.body.status;
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotency_key || null;
    const lead = await LeadsRepository.updateStatus(
      cleanId,
      nextStage,
      req.body.lost_reason || req.body.lost_reason_code,
      req.body.comment || req.body.lost_reason_comment,
      parseOptionalBigInt(req.user?.id),
      {
        expectedVersion: req.body.version,
        idempotencyKey,
        meetingAt: req.body.meeting_at,
        showingProjectId: req.body.showing_project_id,
        showingAt: req.body.showing_at,
        showingOutcome: req.body.showing_outcome
      }
    );

    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) {
    if (error?.statusCode === 409 && error.current) {
      return res.status(409).json({
        status: 'error',
        code: error.code || 'VERSION_CONFLICT',
        message: error.message,
        data: { current: error.current }
      });
    }
    next(error);
  }
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
