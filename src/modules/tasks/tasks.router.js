import express from 'express';
import { TasksRepository } from './tasks.repository.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

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
      assignedUserId: req.query.assignedUserId,
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
    const task = await TasksRepository.findById(req.params.id);
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
      created_by: req.user.id,
      assigned_user_id: req.body.assigned_user_id || req.user.id,
    });
    res.status(201).json({ status: 'success', data: { task } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/tasks/:id
router.put('/:id', async (req, res, next) => {
  try {
    const task = await TasksRepository.update(req.params.id, req.body);
    res.status(200).json({ status: 'success', data: { task } });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/tasks/:id/status
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status) return next(new AppError('Статус обязателен', 400));
    const task = await TasksRepository.updateStatus(req.params.id, status);
    res.status(200).json({ status: 'success', data: { task } });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await TasksRepository.delete(req.params.id);
    res.status(200).json({ status: 'success', message: 'Задача удалена' });
  } catch (error) {
    next(error);
  }
});

export default router;
