import express from 'express';
import { Tour360Repository } from './tour360.repository.js';
import {
  createTourSchema,
  updateTourSchema,
  createPanoramaSchema,
  updatePanoramaSchema,
  createHotspotSchema,
  updateHotspotSchema,
  uploadUrl360Schema
} from './tour360.validator.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const router = express.Router({ mergeParams: true });

function formatZodError(error) {
  const issues = error.issues || error.errors || [];
  return issues.map(i => i.message).join(', ') || error.message;
}

// All 360 tour routes require authentication
router.use(protect);

// -------------------------------------------------------------
// 360 TOURS
// -------------------------------------------------------------

// GET /api/projects/:projectId/360-tours
router.get('/projects/:projectId/360-tours', async (req, res, next) => {
  try {
    const tours = await Tour360Repository.findToursByProjectId(req.params.projectId, req.query);
    res.status(200).json({
      status: 'success',
      results: tours.length,
      data: { tours }
    });
  } catch (error) { next(error); }
});

// GET /api/360-tours/:tourId
router.get('/360-tours/:tourId', async (req, res, next) => {
  try {
    const tour = await Tour360Repository.getTourTree(req.params.tourId);
    res.status(200).json({
      status: 'success',
      data: { tour }
    });
  } catch (error) { next(error); }
});

// POST /api/projects/:projectId/360-tours
router.post('/projects/:projectId/360-tours', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = createTourSchema.parse(req.body);
    const tour = await Tour360Repository.createTour(req.params.projectId, validated);
    res.status(201).json({
      status: 'success',
      data: { tour }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// PATCH /api/360-tours/:tourId
router.patch('/360-tours/:tourId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = updateTourSchema.parse(req.body);
    const tour = await Tour360Repository.updateTour(req.params.tourId, validated);
    res.status(200).json({
      status: 'success',
      data: { tour }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// DELETE /api/360-tours/:tourId
router.delete('/360-tours/:tourId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    await Tour360Repository.deleteTour(req.params.tourId);
    res.status(204).json({
      status: 'success',
      data: null
    });
  } catch (error) { next(error); }
});

// POST /api/360-tours/upload-url and /api/360-panoramas/upload-url
router.post(['/360-tours/upload-url', '/360-panoramas/upload-url'], restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = uploadUrl360Schema.parse(req.body);
    const uploadData = await Tour360Repository.generateUploadUrl(validated.projectId, validated);
    res.status(200).json({
      status: 'success',
      data: uploadData
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// -------------------------------------------------------------
// PANORAMAS
// -------------------------------------------------------------

// GET /api/360-tours/:tourId/panoramas
router.get('/360-tours/:tourId/panoramas', async (req, res, next) => {
  try {
    const panoramas = await Tour360Repository.getPanoramas(req.params.tourId);
    res.status(200).json({
      status: 'success',
      results: panoramas.length,
      data: { panoramas }
    });
  } catch (error) { next(error); }
});

// POST /api/360-tours/:tourId/panoramas
router.post('/360-tours/:tourId/panoramas', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = createPanoramaSchema.parse(req.body);
    const panorama = await Tour360Repository.createPanorama(req.params.tourId, validated);
    res.status(201).json({
      status: 'success',
      data: { panorama }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// PATCH /api/360-panoramas/:panoramaId
router.patch('/360-panoramas/:panoramaId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = updatePanoramaSchema.parse(req.body);
    const panorama = await Tour360Repository.updatePanorama(req.params.panoramaId, validated);
    res.status(200).json({
      status: 'success',
      data: { panorama }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// DELETE /api/360-panoramas/:panoramaId
router.delete('/360-panoramas/:panoramaId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    await Tour360Repository.deletePanorama(req.params.panoramaId);
    res.status(204).json({
      status: 'success',
      data: null
    });
  } catch (error) { next(error); }
});

// -------------------------------------------------------------
// HOTSPOTS
// -------------------------------------------------------------

// GET /api/360-panoramas/:panoramaId/hotspots
router.get('/360-panoramas/:panoramaId/hotspots', async (req, res, next) => {
  try {
    const hotspots = await Tour360Repository.getHotspots(req.params.panoramaId);
    res.status(200).json({
      status: 'success',
      results: hotspots.length,
      data: { hotspots }
    });
  } catch (error) { next(error); }
});

// POST /api/360-panoramas/:panoramaId/hotspots
router.post('/360-panoramas/:panoramaId/hotspots', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = createHotspotSchema.parse(req.body);
    const hotspot = await Tour360Repository.createHotspot(req.params.panoramaId, validated);
    res.status(201).json({
      status: 'success',
      data: { hotspot }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// PATCH /api/360-hotspots/:hotspotId
router.patch('/360-hotspots/:hotspotId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = updateHotspotSchema.parse(req.body);
    const hotspot = await Tour360Repository.updateHotspot(req.params.hotspotId, validated);
    res.status(200).json({
      status: 'success',
      data: { hotspot }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// DELETE /api/360-hotspots/:hotspotId
router.delete('/360-hotspots/:hotspotId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    await Tour360Repository.deleteHotspot(req.params.hotspotId);
    res.status(204).json({
      status: 'success',
      data: null
    });
  } catch (error) { next(error); }
});

export default router;
