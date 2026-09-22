import express from 'express';
import { LayoutPresentationRepository } from './layout_presentation.repository.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { parseRequiredBigInt } from '../../utils/idNormalizer.js';

const router = express.Router();
router.use(protect);

/**
 * GET /api/inventory/units/:unitId/presentation
 * Aggregated presentation bundle for an apartment unit
 */
router.get('/units/:unitId/presentation', async (req, res, next) => {
  try {
    const cleanUnitId = parseRequiredBigInt(req.params.unitId, 'unitId');
    const presentation = await LayoutPresentationRepository.getUnitPresentationData(cleanUnitId, req.user);

    // Attach user role permissions for UI gating
    const userRole = req.user?.role || 'SALES_MANAGER';
    const permissions = {
      canEditLayout: userRole === 'ADMIN',
      canReserve: ['ADMIN', 'SALES_MANAGER'].includes(userRole),
      canCreateDeal: ['ADMIN', 'SALES_MANAGER'].includes(userRole),
      canManagePrices: userRole === 'ADMIN',
    };

    res.status(200).json({
      status: 'success',
      data: {
        ...presentation,
        permissions,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/inventory/layouts/:layoutId/presentation
 * Admin presentation configuration for a layout type
 */
router.get('/layouts/:layoutId/presentation', async (req, res, next) => {
  try {
    const cleanLayoutId = parseRequiredBigInt(req.params.layoutId, 'layoutId');
    const data = await LayoutPresentationRepository.getLayoutPresentationData(cleanLayoutId, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/inventory/layouts/:layoutId/extended
 * Update extended fields of layout type (areas, descriptions, finishings)
 */
router.patch('/layouts/:layoutId/extended', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanLayoutId = parseRequiredBigInt(req.params.layoutId, 'layoutId');
    const layout = await LayoutPresentationRepository.updateLayoutExtended(cleanLayoutId, req.body, req.user);
    res.status(200).json({ status: 'success', data: { layout } });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/inventory/layouts/:layoutId/rooms
 * Create a new layout room
 */
router.post('/layouts/:layoutId/rooms', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanLayoutId = parseRequiredBigInt(req.params.layoutId, 'layoutId');
    const room = await LayoutPresentationRepository.createRoom(cleanLayoutId, req.body, req.user);
    res.status(201).json({ status: 'success', data: { room } });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/inventory/layouts/:layoutId/rooms/:roomId
 * Update a layout room (position, polygon, descriptions, finishes)
 */
router.patch('/layouts/:layoutId/rooms/:roomId', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanLayoutId = parseRequiredBigInt(req.params.layoutId, 'layoutId');
    const cleanRoomId = parseRequiredBigInt(req.params.roomId, 'roomId');
    const room = await LayoutPresentationRepository.updateRoom(cleanLayoutId, cleanRoomId, req.body, req.user);
    res.status(200).json({ status: 'success', data: { room } });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/inventory/layouts/:layoutId/rooms/:roomId
 * Delete a layout room
 */
router.delete('/layouts/:layoutId/rooms/:roomId', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanLayoutId = parseRequiredBigInt(req.params.layoutId, 'layoutId');
    const cleanRoomId = parseRequiredBigInt(req.params.roomId, 'roomId');
    await LayoutPresentationRepository.deleteRoom(cleanLayoutId, cleanRoomId, req.user);
    res.status(204).json({ status: 'success', data: null });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/inventory/layouts/:layoutId/features
 * Add a feature to layout
 */
router.post('/layouts/:layoutId/features', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanLayoutId = parseRequiredBigInt(req.params.layoutId, 'layoutId');
    const feature = await LayoutPresentationRepository.createFeature(cleanLayoutId, req.body, req.user);
    res.status(201).json({ status: 'success', data: { feature } });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/inventory/layouts/:layoutId/features/:featureId
 * Update a layout feature
 */
router.patch('/layouts/:layoutId/features/:featureId', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanLayoutId = parseRequiredBigInt(req.params.layoutId, 'layoutId');
    const cleanFeatureId = parseRequiredBigInt(req.params.featureId, 'featureId');
    const feature = await LayoutPresentationRepository.updateFeature(cleanLayoutId, cleanFeatureId, req.body, req.user);
    res.status(200).json({ status: 'success', data: { feature } });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/inventory/layouts/:layoutId/features/:featureId
 * Delete a layout feature
 */
router.delete('/layouts/:layoutId/features/:featureId', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const cleanLayoutId = parseRequiredBigInt(req.params.layoutId, 'layoutId');
    const cleanFeatureId = parseRequiredBigInt(req.params.featureId, 'featureId');
    await LayoutPresentationRepository.deleteFeature(cleanLayoutId, cleanFeatureId, req.user);
    res.status(204).json({ status: 'success', data: null });
  } catch (error) {
    next(error);
  }
});

export default router;
