import express from 'express';
import { Visual3DRepository } from './visual3d.repository.js';
import {
  createSceneSchema,
  updateSceneSchema,
  createEntitySchema,
  updateEntitySchema,
  batchEntitiesSchema,
  uploadUrl3DSchema
} from './visual3d.validator.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const router = express.Router({ mergeParams: true });

function formatZodError(error) {
  const issues = error.issues || error.errors || [];
  return issues.map(i => i.message).join(', ') || error.message;
}

// All 3D routes require authentication
router.use(protect);

// -------------------------------------------------------------
// 3D SCENES
// -------------------------------------------------------------

// GET /api/projects/:projectId/3d-scenes
router.get('/projects/:projectId/3d-scenes', async (req, res, next) => {
  try {
    const scenes = await Visual3DRepository.findByProjectId(req.params.projectId, req.query);
    res.status(200).json({
      status: 'success',
      results: scenes.length,
      data: { scenes }
    });
  } catch (error) { next(error); }
});

// GET /api/3d-scenes/:sceneId
router.get('/3d-scenes/:sceneId', async (req, res, next) => {
  try {
    const scene = await Visual3DRepository.findById(req.params.sceneId);
    if (!scene) return next(new AppError('3D сцена не найдена', 404));
    res.status(200).json({
      status: 'success',
      data: { scene }
    });
  } catch (error) { next(error); }
});

// POST /api/projects/:projectId/3d-scenes
router.post('/projects/:projectId/3d-scenes', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = createSceneSchema.parse(req.body);
    const scene = await Visual3DRepository.create(req.params.projectId, validated);
    res.status(201).json({
      status: 'success',
      data: { scene }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// PATCH /api/3d-scenes/:sceneId
router.patch('/3d-scenes/:sceneId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = updateSceneSchema.parse(req.body);
    const scene = await Visual3DRepository.update(req.params.sceneId, validated);
    res.status(200).json({
      status: 'success',
      data: { scene }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// POST /api/3d-scenes/:sceneId/activate (Atomic activation)
router.post('/3d-scenes/:sceneId/activate', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const scene = await Visual3DRepository.activate(req.params.sceneId);
    res.status(200).json({
      status: 'success',
      data: { scene }
    });
  } catch (error) { next(error); }
});

// DELETE /api/3d-scenes/:sceneId
router.delete('/3d-scenes/:sceneId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    await Visual3DRepository.delete(req.params.sceneId);
    res.status(204).json({
      status: 'success',
      data: null
    });
  } catch (error) { next(error); }
});

// POST /api/3d-scenes/upload-url (Generate presigned upload URL for GLB model)
router.post('/3d-scenes/upload-url', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = uploadUrl3DSchema.parse(req.body);
    const uploadData = await Visual3DRepository.generateUploadUrl(validated.projectId, validated);
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
// SCENE ENTITIES / MESH MAPPINGS
// -------------------------------------------------------------

// GET /api/3d-scenes/:sceneId/entities and GET /api/3d-scenes/:sceneId/resolved-entities
router.get(['/3d-scenes/:sceneId/entities', '/3d-scenes/:sceneId/resolved-entities'], async (req, res, next) => {
  try {
    const entities = await Visual3DRepository.getEntities(req.params.sceneId);
    res.status(200).json({
      status: 'success',
      results: entities.length,
      data: { entities }
    });
  } catch (error) { next(error); }
});

// POST /api/3d-scenes/:sceneId/entities
router.post('/3d-scenes/:sceneId/entities', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = createEntitySchema.parse(req.body);
    const entity = await Visual3DRepository.createEntity(req.params.sceneId, validated);
    res.status(201).json({
      status: 'success',
      data: { entity }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// POST /api/3d-scenes/:sceneId/entities/batch
router.post('/3d-scenes/:sceneId/entities/batch', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = batchEntitiesSchema.parse(req.body);
    const entities = await Visual3DRepository.batchCreateEntities(req.params.sceneId, validated.entities);
    res.status(201).json({
      status: 'success',
      results: entities.length,
      data: { entities }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// GET /api/3d-scenes/:sceneId/entities/:meshKey/resolve (Resolve 3D mesh to CRM unit on hover/click)
router.get('/3d-scenes/:sceneId/entities/:meshKey/resolve', async (req, res, next) => {
  try {
    const resolution = await Visual3DRepository.resolveMesh(req.params.sceneId, req.params.meshKey);
    res.status(200).json({
      status: 'success',
      data: resolution
    });
  } catch (error) { next(error); }
});

// PATCH /api/3d-scene-entities/:entityId
router.patch('/3d-scene-entities/:entityId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = updateEntitySchema.parse(req.body);
    const entity = await Visual3DRepository.updateEntity(req.params.entityId, validated);
    res.status(200).json({
      status: 'success',
      data: { entity }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// DELETE /api/3d-scene-entities/:entityId
router.delete('/3d-scene-entities/:entityId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    await Visual3DRepository.deleteEntity(req.params.entityId);
    res.status(204).json({
      status: 'success',
      data: null
    });
  } catch (error) { next(error); }
});

export default router;
