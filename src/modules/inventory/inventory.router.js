import express from 'express';
import { InventoryRepository } from './inventory.repository.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const router = express.Router();
router.use(protect);

router.get('/projects/:projectId/stats', async (req, res, next) => {
  try {
    const stats = await InventoryRepository.getProjectStats(req.params.projectId);
    res.status(200).json({ status: 'success', data: { stats } });
  } catch (error) { next(error); }
});

router.get('/projects/:projectId/structure', async (req, res, next) => {
  try {
    const structure = await InventoryRepository.getStructure(req.params.projectId);
    res.status(200).json({ status: 'success', data: { structure } });
  } catch (error) { next(error); }
});

router.post('/buildings', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const building = await InventoryRepository.createBuilding(req.body);
    res.status(201).json({ status: 'success', data: { building } });
  } catch (error) { next(error); }
});

router.post('/sections', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const section = await InventoryRepository.createSection(req.body);
    res.status(201).json({ status: 'success', data: { section } });
  } catch (error) { next(error); }
});

router.post('/floors', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const floor = await InventoryRepository.createFloor(req.body);
    res.status(201).json({ status: 'success', data: { floor } });
  } catch (error) { next(error); }
});

router.get(['/projects/:projectId/layout-types', '/projects/:projectId/layouts'], async (req, res, next) => {
  try {
    const layoutTypes = await InventoryRepository.getLayoutTypes(req.params.projectId);
    res.status(200).json({ status: 'success', data: { layoutTypes, layouts: layoutTypes } });
  } catch (error) { next(error); }
});

router.post(['/layout-types', '/projects/:projectId/layouts'], restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const payload = { ...req.body };
    if (req.params.projectId && !payload.project_id) {
      payload.project_id = req.params.projectId;
    }
    const layoutType = await InventoryRepository.createLayoutType(payload);
    res.status(201).json({ status: 'success', data: { layoutType, layout: layoutType } });
  } catch (error) { next(error); }
});

router.delete(['/layout-types/:id', '/layouts/:id'], restrictTo('ADMIN'), async (req, res, next) => {
  try {
    await InventoryRepository.deleteLayoutType(req.params.id);
    res.status(204).json({ status: 'success', data: null });
  } catch (error) { next(error); }
});

router.post(['/units/batch-generate', '/projects/:projectId/batch-generate'], restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const payload = { ...req.body };
    if (req.params.projectId && !payload.projectId) {
      payload.projectId = req.params.projectId;
    }
    const result = await InventoryRepository.batchGenerateUnits(payload);
    res.status(201).json({ status: 'success', data: result });
  } catch (error) { next(error); }
});

router.get('/projects/:projectId/chessboard', async (req, res, next) => {
  try {
    const chessboard = await InventoryRepository.getChessboard(req.params.projectId, req.query);
    res.status(200).json({ status: 'success', data: { chessboard } });
  } catch (error) { next(error); }
});

router.get('/units/:id', async (req, res, next) => {
  try {
    const unit = await InventoryRepository.getUnitById(req.params.id);
    if (!unit) return next(new AppError('Квартира не найдена', 404));
    res.status(200).json({ status: 'success', data: { unit } });
  } catch (error) { next(error); }
});

router.patch('/units/:id/status', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const { status, block_reason } = req.body;
    const unit = await InventoryRepository.updateUnitStatus(req.params.id, status, block_reason);
    res.status(200).json({ status: 'success', data: { unit } });
  } catch (error) { next(error); }
});

router.patch('/units/batch-price', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const { unit_ids, price_per_m2_minor } = req.body;
    const result = await InventoryRepository.updateUnitsBatchPrice(unit_ids, price_per_m2_minor);
    res.status(200).json({ status: 'success', data: result });
  } catch (error) { next(error); }
});

router.patch('/units/:id/price', restrictTo('ADMIN', 'SALES_MANAGER', 'DIRECTOR', 'FINANCE_MANAGER'), async (req, res, next) => {
  try {
    const { price_per_m2_minor, scope, scopeOptions, unit_ids } = req.body;
    // If not ADMIN, strictly restrict scope to only the single current unit
    const effectiveScope = req.user?.role === 'ADMIN' ? (scope || 'UNIT') : 'UNIT';
    const effectiveScopeOptions = req.user?.role === 'ADMIN' 
      ? (scopeOptions || (unit_ids ? { unit_ids } : {}))
      : { unit_ids: [req.params.id] };

    const unit = await InventoryRepository.updateUnitPrice(req.params.id, price_per_m2_minor, effectiveScope, effectiveScopeOptions);
    res.status(200).json({ status: 'success', data: { unit } });
  } catch (error) { next(error); }
});

export default router;
