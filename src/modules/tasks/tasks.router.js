import express from 'express';
import { TasksRepository } from './tasks.repository.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';

const router = express.Router();

router.use(protect);

// GET /api/tasks
router.get('/', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      type: req.query.type,
      priority: req.query.priority,
      assignedUserId: parseOptionalBigInt(req.query.assignedUserId),
      dateFilter: req.query.dateFilter,
    };
    const tasks = await TasksRepository.findAll(filters);
    res.status(200).json({ status: 'success', data: { tasks } });
  } catch (error) {
    next(error);
  }
});

// GET /api/tasks/:id
router.get('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const task = await TasksRepository.findById(cleanId);
    if (!task) return next(new AppError('Задача не найдена', 404));
    res.status(200).json({ status: 'success', data: { task } });
  } catch (error) {
    next(error);
  }
});

// POST /api/tasks
router.post('/', async (req, res, next) => {
  try {
    const task = await TasksRepository.create({
      ...req.body,
      lead_id: parseOptionalBigInt(req.body.lead_id),
      deal_id: parseOptionalBigInt(req.body.deal_id),
      created_by: parseOptionalBigInt(req.user.id) || 1,
      assigned_user_id: parseOptionalBigInt(req.body.assigned_user_id) || parseOptionalBigInt(req.user.id) || 1,
    });
    res.status(201).json({ status: 'success', data: { task } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/tasks/:id
router.put('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const task = await TasksRepository.update(cleanId, {
      ...req.body,
      lead_id: parseOptionalBigInt(req.body.lead_id),
      deal_id: parseOptionalBigInt(req.body.deal_id),
      assigned_user_id: parseOptionalBigInt(req.body.assigned_user_id)
    });
    res.status(200).json({ status: 'success', data: { task } });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/tasks/:id/status
router.patch('/:id/status', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const { status } = req.body;
    if (!status) return next(new AppError('Статус обязателен', 400));
    const task = await TasksRepository.updateStatus(cleanId, status);
    res.status(200).json({ status: 'success', data: { task } });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    await TasksRepository.delete(cleanId);
    res.status(200).json({ status: 'success', message: 'Задача удалена' });
  } catch (error) {
    next(error);
  }
});

export default router;
