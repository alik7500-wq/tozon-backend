import express from 'express';
import { LeadsRepository } from './leads.repository.js';
import { TasksService } from '../tasks/tasks.service.js';
import { ManagerPerformanceService } from '../reports/managerPerformance.service.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';

const router = express.Router();

// Public Webhook for external websites, landing pages, Telegram bots and Social Ads (Instagram / Facebook / WhatsApp)
router.post('/webhook', async (req, res, next) => {
  try {
    const { full_name, phone, secondary_phone, source, notes, project_name, rooms, budget } = req.body;

    if (!full_name || !phone) {
      return next(new AppError('Поля ФИО (full_name) и Телефон (phone) обязательны', 400));
    }

    const leadPayload = {
      full_name,
      phone,
      secondary_phone: secondary_phone || null,
      source: source || 'WEBSITE',
      status: 'NEW',
      notes: notes || `Заявка с онлайн-источника (${source || 'Сайт'}).`,
      responsible_user_id: 1, // Default to admin / queue
    };

    const lead = await LeadsRepository.create(leadPayload);

    // Auto-generate high-priority call task for manager
    await TasksService.onLeadCreated(lead, 1);

    res.status(201).json({
      status: 'success',
      message: 'Заявка успешно принята в Tozon CRM',
      data: { leadId: lead.id, client: lead.full_name, status: lead.status }
    });
  } catch (error) {
    next(error);
  }
});

router.use(protect);

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

router.get('/', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      projectId: parseOptionalBigInt(req.query.projectId),
      responsibleUserId: parseOptionalBigInt(req.query.responsibleUserId)
    };
    // RBAC: SALES_MANAGER is strictly restricted to viewing only their own assigned leads
    if (req.user?.role === 'SALES_MANAGER') {
      filters.responsibleUserId = req.user.id;
    }
    const leads = await LeadsRepository.findAll(filters);
    res.status(200).json({ status: 'success', data: { leads } });
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const lead = await LeadsRepository.findById(cleanId);
    if (!lead) return next(new AppError('Лид не найден', 404));
    // RBAC: SALES_MANAGER can only inspect their own leads
    if (req.user?.role === 'SALES_MANAGER' && lead.responsible_user_id && Number(lead.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к просмотру лидов других менеджеров', 403));
    }
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const payload = { ...req.body };
    if (req.user?.role === 'SALES_MANAGER' && !payload.responsible_user_id) {
      payload.responsible_user_id = req.user.id;
    }
    const lead = await LeadsRepository.create(payload);
    // Auto-generate task for responsible manager
    await TasksService.onLeadCreated(lead, parseOptionalBigInt(req.user.id) || 1);
    res.status(201).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));
    if (req.user?.role === 'SALES_MANAGER' && existing.responsible_user_id && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к редактированию лидов других менеджеров', 403));
    }
    if (req.body.responsible_user_id !== undefined && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
      return next(new AppError('Переназначение ответственного менеджера разрешено только руководителю или администратору', 403));
    }
    const lead = await LeadsRepository.update(cleanId, req.body);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));
    if (req.user?.role === 'SALES_MANAGER' && existing.responsible_user_id && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к редактированию лидов других менеджеров', 403));
    }
    if (req.body.responsible_user_id !== undefined && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
      return next(new AppError('Переназначение ответственного менеджера разрешено только руководителю или администратору', 403));
    }
    const lead = await LeadsRepository.update(cleanId, req.body);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));
    if (req.user?.role === 'SALES_MANAGER' && existing.responsible_user_id && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к изменению статуса лидов других менеджеров', 403));
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

router.post('/:id/notes', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));
    if (req.user?.role === 'SALES_MANAGER' && existing.responsible_user_id && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к лидам других менеджеров', 403));
    }
    const note = await LeadsRepository.addNote(cleanId, parseOptionalBigInt(req.user.id) || 1, req.body.body);
    res.status(201).json({ status: 'success', data: { note } });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await LeadsRepository.findById(cleanId);
    if (!existing) return next(new AppError('Лид не найден', 404));
    if (['SALES_MANAGER', 'MANAGER'].includes(req.user?.role) && existing.responsible_user_id && Number(existing.responsible_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к удалению лидов других менеджеров', 403));
    }
    await LeadsRepository.archive(cleanId);
    res.status(204).json({ status: 'success', data: null });
  } catch (error) { next(error); }
});

export default router;
