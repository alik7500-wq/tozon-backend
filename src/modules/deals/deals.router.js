import express from 'express';
import { DealsRepository } from './deals.repository.js';
import { TasksService } from '../tasks/tasks.service.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';

const router = express.Router();

router.use(protect);

router.get('/stats', async (req, res, next) => {
  try {
    const stats = await DealsRepository.getStats();
    res.status(200).json({ status: 'success', data: { stats } });
  } catch (error) {
    next(error);
  }
});

router.get('/available-units', async (req, res, next) => {
  try {
    const cleanProjectId = parseOptionalBigInt(req.query.projectId);
    const units = await DealsRepository.getAvailableUnits(cleanProjectId);
    res.status(200).json({ status: 'success', data: { units } });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      projectId: parseOptionalBigInt(req.query.projectId),
      paymentType: req.query.paymentType,
    };
    const deals = await DealsRepository.findAll(filters);
    res.status(200).json({ status: 'success', data: { deals } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const deal = await DealsRepository.getDealById(cleanId);
    if (!deal) {
      return next(new AppError('Сделка не найдена', 404));
    }
    res.status(200).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/deals/:id - Update deal details (ADMIN ONLY for corrections)
router.patch('/:id', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const deal = await DealsRepository.updateDeal(cleanId, req.body, req.user.id);
    res.status(200).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const leadId = parseRequiredBigInt(req.body.lead_id, 'lead_id');
    const unitId = parseRequiredBigInt(req.body.unit_id, 'unit_id');
    const { final_price_minor } = req.body;
    if (final_price_minor === undefined) {
      return next(new AppError('Сумма сделки обязательна', 400));
    }

    const deal = await DealsRepository.createDeal({
      ...req.body,
      lead_id: leadId,
      unit_id: unitId
    }, req.user.id);

    // Auto-generate task for reservation control
    await TasksService.onDealCreated(deal, req.user.id);
    res.status(201).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/sign', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const deal = await DealsRepository.signDeal(cleanId, req.user.id);
    // Auto-generate task for payment control
    await TasksService.onDealSigned(deal, req.user.id);
    res.status(200).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const { reason } = req.body;
    const deal = await DealsRepository.cancelDeal(cleanId, reason, req.user.id, req.user.role);
    res.status(200).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/extend-reservation', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const { reservation_expires_at } = req.body;
    if (!reservation_expires_at) {
      return next(new AppError('Укажите новую дату окончания брони', 400));
    }
    const deal = await DealsRepository.extendReservation(cleanId, reservation_expires_at, req.user.id);
    res.status(200).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/payments', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const { amount_minor, payment_date, method, schedule_id, reference, comment } = req.body;
    if (!amount_minor || amount_minor <= 0) {
      return next(new AppError('Сумма платежа обязательна и должна быть больше нуля', 400));
    }

    const deal = await DealsRepository.recordPayment(
      cleanId,
      {
        amount_minor,
        payment_date,
        method,
        schedule_id: parseOptionalBigInt(schedule_id),
        reference,
        comment
      },
      req.user.id
    );
    res.status(201).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

export default router;
