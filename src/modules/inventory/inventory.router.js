import express from 'express';
import { InventoryRepository } from './inventory.repository.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';

const router = express.Router();
router.use(protect);

router.get('/projects/:projectId/stats', async (req, res, next) => {
  try {
    const cleanProjectId = parseRequiredBigInt(req.params.projectId, 'projectId');
    const stats = await InventoryRepository.getProjectStats(cleanProjectId);
    res.status(200).json({ status: 'success', data: { stats } });
  } catch (error) { next(error); }
});

router.get('/projects/:projectId/structure', async (req, res, next) => {
  try {
    const cleanProjectId = parseRequiredBigInt(req.params.projectId, 'projectId');
    const structure = await InventoryRepository.getStructure(cleanProjectId);
    res.status(200).json({ status: 'success', data: { structure } });
  } catch (error) { next(error); }
});

router.post('/buildings', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const building = await InventoryRepository.createBuilding({
      ...req.body,
      project_id: parseRequiredBigInt(req.body.project_id, 'project_id')
    });
    res.status(201).json({ status: 'success', data: { building } });
  } catch (error) { next(error); }
});

router.post('/sections', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const section = await InventoryRepository.createSection({
      ...req.body,
      building_id: parseRequiredBigInt(req.body.building_id, 'building_id')
    });
    res.status(201).json({ status: 'success', data: { section } });
  } catch (error) { next(error); }
});

router.post('/floors', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const floor = await InventoryRepository.createFloor({
      ...req.body,
      section_id: parseRequiredBigInt(req.body.section_id, 'section_id')
    });
    res.status(201).json({ status: 'success', data: { floor } });
  } catch (error) { next(error); }
});

router.get(['/projects/:projectId/layout-types', '/projects/:projectId/layouts'], async (req, res, next) => {
  try {
    const cleanProjectId = parseRequiredBigInt(req.params.projectId, 'projectId');
    const layoutTypes = await InventoryRepository.getLayoutTypes(cleanProjectId);
    res.status(200).json({ status: 'success', data: { layoutTypes, layouts: layoutTypes } });
  } catch (error) { next(error); }
});

router.post(['/layout-types', '/projects/:projectId/layouts'], restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const payload = { ...req.body };
    const pId = req.params.projectId || payload.project_id;
    payload.project_id = parseRequiredBigInt(pId, 'project_id');
    const layoutType = await InventoryRepository.createLayoutType(payload);
    res.status(201).json({ status: 'success', data: { layoutType, layout: layoutType } });
  } catch (error) { next(error); }
});

router.delete(['/layout-types/:id', '/layouts/:id'], restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    await InventoryRepository.deleteLayoutType(cleanId);
    res.status(204).json({ status: 'success', data: null });
  } catch (error) { next(error); }
});

router.post(['/units/batch-generate', '/projects/:projectId/batch-generate'], restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const payload = { ...req.body };
    const pId = req.params.projectId || payload.projectId;
    payload.projectId = parseRequiredBigInt(pId, 'projectId');
    const result = await InventoryRepository.batchGenerateUnits(payload);
    res.status(201).json({ status: 'success', data: result });
  } catch (error) { next(error); }
});

router.get('/projects/:projectId/chessboard', async (req, res, next) => {
  try {
    const cleanProjectId = parseRequiredBigInt(req.params.projectId, 'projectId');
    const chessboard = await InventoryRepository.getChessboard(cleanProjectId, req.query);
    res.status(200).json({ status: 'success', data: { chessboard } });
  } catch (error) { next(error); }
});

router.get('/units/:id', async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const unit = await InventoryRepository.getUnitById(cleanId);
    if (!unit) return next(new AppError('Квартира не найдена', 404));
    res.status(200).json({ status: 'success', data: { unit } });
  } catch (error) { next(error); }
});

router.patch('/units/:id/status', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const { status, block_reason } = req.body;
    const unit = await InventoryRepository.updateUnitStatus(cleanId, status, block_reason);
    res.status(200).json({ status: 'success', data: { unit } });
  } catch (error) { next(error); }
});

router.patch('/units/batch-price', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const { unit_ids, price_per_m2_minor } = req.body;
    const cleanUnitIds = (unit_ids || []).map(id => parseRequiredBigInt(id, 'unit_id'));
    const result = await InventoryRepository.updateUnitsBatchPrice(cleanUnitIds, price_per_m2_minor);
    res.status(200).json({ status: 'success', data: result });
  } catch (error) { next(error); }
});

router.patch('/units/:id/price', restrictTo('ADMIN', 'SALES_MANAGER', 'DIRECTOR', 'FINANCE_MANAGER'), async (req, res, next) => {
  try {
    const cleanId = parseRequiredBigInt(req.params.id, 'id');
    const { price_per_m2_minor, scope, scopeOptions, unit_ids } = req.body;
    // If not ADMIN, strictly restrict scope to only the single current unit
    const effectiveScope = req.user?.role === 'ADMIN' ? (scope || 'UNIT') : 'UNIT';
    const effectiveScopeOptions = req.user?.role === 'ADMIN' 
      ? (scopeOptions || (unit_ids ? { unit_ids } : {}))
      : { unit_ids: [cleanId] };

    const unit = await InventoryRepository.updateUnitPrice(cleanId, price_per_m2_minor, effectiveScope, effectiveScopeOptions);
    res.status(200).json({ status: 'success', data: { unit } });
  } catch (error) { next(error); }
});

export default router;
