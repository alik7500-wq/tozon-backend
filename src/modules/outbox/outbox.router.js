import { Router } from 'express';
import { protect, restrictTo, checkPermission } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { OutboxWorkerService } from './outboxWorker.service.js';

const router = Router();
router.use(protect);

router.get('/diagnostics', restrictTo('ADMIN', 'DIRECTOR'), checkPermission('settings.view'), async (_req, res, next) => {
  try {
    const data = await OutboxWorkerService.getDiagnostics();
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

router.get('/preview-cutoff', restrictTo('ADMIN', 'DIRECTOR'), checkPermission('settings.view'), async (req, res, next) => {
  try {
    const data = await OutboxWorkerService.previewCutoff({ cutoffAt: req.query.cutoffAt });
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

router.patch('/settings', restrictTo('ADMIN'), checkPermission('settings.manage'), async (req, res, next) => {
  try {
    const data = await OutboxWorkerService.updateSettings({
      isEnabled: req.body?.is_enabled,
      cutoffAt: req.body?.cutoff_at,
      batchSize: req.body?.batch_size,
      leaseSeconds: req.body?.lease_seconds,
      actorUserId: req.user?.id
    });
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

router.post('/run-once', restrictTo('ADMIN'), checkPermission('settings.manage'), async (req, res, next) => {
  try {
    const rawIgnoreEnabled = req.body?.ignore_enabled;
    if (rawIgnoreEnabled !== undefined && typeof rawIgnoreEnabled !== 'boolean') {
      throw new AppError('Поле ignore_enabled должно быть boolean', 400);
    }
    const data = await OutboxWorkerService.runOnce({
      workerId: `api_${req.user?.id || 'admin'}`,
      batchSize: req.body?.batch_size || 25,
      ignoreEnabled: rawIgnoreEnabled === true,
      actorUserId: req.user?.id || null
    });
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

router.post('/quarantine/:id/replay', restrictTo('ADMIN'), checkPermission('settings.manage'), async (req, res, next) => {
  try {
    const data = await OutboxWorkerService.replayQuarantined({
      eventId: req.params.id,
      actorUserId: req.user?.id
    });
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

export default router;
