import express from 'express';
import { LeadsRepository } from './leads.repository.js';
import { TasksService } from '../tasks/tasks.service.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const router = express.Router();
router.use(protect);

router.get('/', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      projectId: req.query.projectId,
      responsibleUserId: req.query.responsibleUserId
    };
    const leads = await LeadsRepository.findAll(filters);
    res.status(200).json({ status: 'success', data: { leads } });
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const lead = await LeadsRepository.findById(req.params.id);
    if (!lead) return next(new AppError('Лид не найден', 404));
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const lead = await LeadsRepository.create(req.body);
    // Auto-generate task for responsible manager
    await TasksService.onLeadCreated(lead, req.user.id);
    res.status(201).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const lead = await LeadsRepository.update(req.params.id, req.body);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const lead = await LeadsRepository.updateStatus(req.params.id, req.body.status, req.body.lost_reason);
    // Auto-generate task on status change
    await TasksService.onLeadStatusChanged(lead, req.body.status, req.user.id);
    res.status(200).json({ status: 'success', data: { lead } });
  } catch (error) { next(error); }
});

router.post('/:id/notes', async (req, res, next) => {
  try {
    const note = await LeadsRepository.addNote(req.params.id, req.user.id, req.body.body);
    res.status(201).json({ status: 'success', data: { note } });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await LeadsRepository.archive(req.params.id);
    res.status(204).json({ status: 'success', data: null });
  } catch (error) { next(error); }
});

export default router;
