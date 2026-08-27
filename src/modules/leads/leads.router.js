import express from 'express';
import { LeadsRepository } from './leads.repository.js';
import { TasksService } from '../tasks/tasks.service.js';
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

router.get('/', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      projectId: parseOptionalBigInt(req.query.projectId),
      responsibleUserId: parseOptionalBigInt(req.query.responsibleUserId)
    };
    const leads = await LeadsRepository.findAll(filters);
    res.status(200).json({ status: 'success', data: { leads } });
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const lead = await LeadsRepository.findById(cleanId);
    if (!lead) return next(new AppError('Лид не найден', 404));
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const lead = await LeadsRepository.create(req.body);
    // Auto-generate task for responsible manager
    await TasksService.onLeadCreated(lead, parseOptionalBigInt(req.user.id) || 1);
    res.status(201).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const lead = await LeadsRepository.update(cleanId, req.body);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const lead = await LeadsRepository.update(cleanId, req.body);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const lead = await LeadsRepository.updateStatus(cleanId, req.body.status, req.body.lost_reason);
    // Auto-generate task on status change
    await TasksService.onLeadStatusChanged(lead, req.body.status, parseOptionalBigInt(req.user.id) || 1);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.post('/:id/notes', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const note = await LeadsRepository.addNote(cleanId, parseOptionalBigInt(req.user.id) || 1, req.body.body);
    res.status(201).json({ status: 'success', data: { note } });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    await LeadsRepository.archive(cleanId);
    res.status(204).json({ status: 'success', data: null });
  } catch (error) { next(error); }
});

export default router;
