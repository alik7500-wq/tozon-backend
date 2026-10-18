import express from 'express';
import { TasksRepository } from './tasks.repository.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';

const router = express.Router();

router.use(protect);

// Strict RBAC: WAREHOUSE_MANAGER has zero access to sales tasks
router.use((req, res, next) => {
  if (req.user?.role === 'WAREHOUSE_MANAGER') {
    return next(new AppError('У вас нет доступа к задачам и продажам', 403));
  }
  next();
});

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
    // RBAC: SALES_MANAGER is strictly restricted to viewing only their own assigned tasks
    if (req.user?.role === 'SALES_MANAGER') {
      filters.assignedUserId = req.user.id;
    }
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
    // RBAC: SALES_MANAGER can only inspect their own tasks
    if (req.user?.role === 'SALES_MANAGER' && task.assigned_user_id && Number(task.assigned_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к задачам других менеджеров', 403));
    }
    res.status(200).json({ status: 'success', data: { task } });
  } catch (error) {
    next(error);
  }
});

// POST /api/tasks
router.post('/', async (req, res, next) => {
  try {
    const isSalesManager = req.user?.role === 'SALES_MANAGER';
    const isFinanceManager = req.user?.role === 'FINANCE_MANAGER';

    // RBAC: SALES_MANAGER can only create tasks assigned to themselves
    let assignedUserId = parseOptionalBigInt(req.body.assigned_user_id);
    if (isSalesManager) {
      assignedUserId = parseRequiredBigInt(req.user.id, 'userId');
    } else if (!assignedUserId) {
      assignedUserId = parseOptionalBigInt(req.user.id) || 1;
    }

    const taskType = req.body.type || 'CALL';
    // RBAC: FINANCE_MANAGER can only create PAYMENT_CONTROL or DOCUMENT tasks or assigned to themselves
    if (isFinanceManager && !['PAYMENT_CONTROL', 'DOCUMENT'].includes(taskType) && Number(assignedUserId) !== Number(req.user.id)) {
      return next(new AppError('Финансовый менеджер может создавать только финансовые задачи (PAYMENT_CONTROL, DOCUMENT)', 403));
    }

    const task = await TasksRepository.create({
      ...req.body,
      type: taskType,
      lead_id: parseOptionalBigInt(req.body.lead_id),
      deal_id: parseOptionalBigInt(req.body.deal_id),
      created_by: parseOptionalBigInt(req.user.id) || 1,
      assigned_user_id: assignedUserId,
      idempotency_key: req.body.idempotency_key || req.headers['idempotency-key'] || null
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
    const existing = await TasksRepository.findById(cleanId);
    if (!existing) return next(new AppError('Задача не найдена', 404));

    const isSalesManager = req.user?.role === 'SALES_MANAGER';
    if (isSalesManager && existing.assigned_user_id && Number(existing.assigned_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к редактированию задач других менеджеров', 403));
    }

    const updatePayload = { ...req.body };
    if (isSalesManager) {
      // SALES_MANAGER cannot reassign task to another manager
      delete updatePayload.assigned_user_id;
    } else if (updatePayload.assigned_user_id !== undefined) {
      updatePayload.assigned_user_id = parseOptionalBigInt(updatePayload.assigned_user_id);
    }

    if (updatePayload.lead_id !== undefined) {
      updatePayload.lead_id = parseOptionalBigInt(updatePayload.lead_id);
    }
    if (updatePayload.deal_id !== undefined) {
      updatePayload.deal_id = parseOptionalBigInt(updatePayload.deal_id);
    }

    const task = await TasksRepository.update(cleanId, updatePayload);
    res.status(200).json({ status: 'success', data: { task } });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/tasks/:id/status
router.patch('/:id/status', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const existing = await TasksRepository.findById(cleanId);
    if (!existing) return next(new AppError('Задача не найдена', 404));
    if (req.user?.role === 'SALES_MANAGER' && existing.assigned_user_id && Number(existing.assigned_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к редактированию задач других менеджеров', 403));
    }
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
    const existing = await TasksRepository.findById(cleanId);
    if (!existing) return next(new AppError('Задача не найдена', 404));

    const isSalesManager = ['SALES_MANAGER', 'MANAGER'].includes(req.user?.role);
    if (isSalesManager && existing.assigned_user_id && Number(existing.assigned_user_id) !== Number(req.user.id)) {
      return next(new AppError('У вас нет доступа к удалению задач других менеджеров', 403));
    }

    // Safety: Protect system deal tasks and financial tasks from deletion by sales reps
    if (isSalesManager && (existing.deal_id || existing.type === 'PAYMENT_CONTROL')) {
      return next(new AppError('Удаление задач по сделкам и финансовому контролю запрещено менеджерам продаж', 403));
    }

    await TasksRepository.delete(cleanId);
    res.status(200).json({ status: 'success', message: 'Задача удалена' });
  } catch (error) {
    next(error);
  }
});

export default router;
