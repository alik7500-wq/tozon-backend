import express from 'express';
import { DealsRepository } from './deals.repository.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

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
    const units = await DealsRepository.getAvailableUnits(req.query.projectId);
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
      projectId: req.query.projectId,
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
    const deal = await DealsRepository.getDealById(req.params.id);
    if (!deal) {
      return next(new AppError('Сделка не найдена', 404));
    }
    res.status(200).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { lead_id, unit_id, final_price_minor } = req.body;
    if (!lead_id || !unit_id || final_price_minor === undefined) {
      return next(new AppError('Покупатель, квартира и сумма сделки обязательны', 400));
    }

    const deal = await DealsRepository.createDeal(req.body, req.user.id);
    res.status(201).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/sign', async (req, res, next) => {
  try {
    const deal = await DealsRepository.signDeal(req.params.id, req.user.id);
    res.status(200).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    const { reason } = req.body;
    const deal = await DealsRepository.cancelDeal(req.params.id, reason, req.user.id, req.user.role);
    res.status(200).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/extend-reservation', async (req, res, next) => {
  try {
    const { reservation_expires_at } = req.body;
    if (!reservation_expires_at) {
      return next(new AppError('Укажите новую дату окончания брони', 400));
    }
    const deal = await DealsRepository.extendReservation(req.params.id, reservation_expires_at, req.user.id);
    res.status(200).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/payments', async (req, res, next) => {
  try {
    const { amount_minor, payment_date, method, schedule_id, reference, comment } = req.body;
    if (!amount_minor || amount_minor <= 0) {
      return next(new AppError('Сумма платежа обязательна и должна быть больше нуля', 400));
    }

    const deal = await DealsRepository.recordPayment(
      req.params.id,
      { amount_minor, payment_date, method, schedule_id, reference, comment },
      req.user.id
    );
    res.status(201).json({ status: 'success', data: { deal } });
  } catch (error) {
    next(error);
  }
});

export default router;
