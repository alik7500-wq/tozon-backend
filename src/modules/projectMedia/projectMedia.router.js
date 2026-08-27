import { Router } from 'express';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { ProjectMediaRepository } from './projectMedia.repository.js';
import { createMediaSchema, updateMediaSchema, uploadUrlSchema } from './projectMedia.validator.js';

const router = Router();

function formatZodError(err) {
  return err.issues?.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') || err.message;
}

// All project media routes require authentication
router.use(protect);

// GET /api/projects/:projectId/media (Accessible to all authenticated staff)
router.get('/projects/:projectId/media', async (req, res, next) => {
  try {
    const media = await ProjectMediaRepository.findByProjectId(req.params.projectId, req.query);
    res.status(200).json({
      status: 'success',
      results: media.length,
      data: { media }
    });
  } catch (error) { next(error); }
});

// GET /api/project-media/:mediaId
router.get('/project-media/:mediaId', async (req, res, next) => {
  try {
    const media = await ProjectMediaRepository.findById(req.params.mediaId);
    if (!media) return next(new AppError('Медиафайл не найден', 404));
    res.status(200).json({
      status: 'success',
      data: { media }
    });
  } catch (error) { next(error); }
});

// POST /api/projects/:projectId/media/upload-url OR /api/project-media/upload-url (Signed upload URL generation)
router.post(['/projects/:projectId/media/upload-url', '/project-media/upload-url'], restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const pId = req.params.projectId || req.body.projectId;
    if (!pId) return next(new AppError('projectId обязателен', 400));
    const validated = uploadUrlSchema.parse({ ...req.body, projectId: pId });
    const urlData = await ProjectMediaRepository.generateUploadUrl(
      validated.projectId,
      validated.filename,
      validated.contentType
    );
    res.status(200).json({
      status: 'success',
      data: urlData
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// POST /api/projects/:projectId/media (Create media record)
router.post('/projects/:projectId/media', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = createMediaSchema.parse(req.body);
    const media = await ProjectMediaRepository.create(req.params.projectId, validated);
    res.status(201).json({
      status: 'success',
      data: { media }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// PATCH /api/project-media/:mediaId (Update title, category, description, etc.)
router.patch('/project-media/:mediaId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const validated = updateMediaSchema.parse(req.body);
    const media = await ProjectMediaRepository.update(req.params.mediaId, validated);
    res.status(200).json({
      status: 'success',
      data: { media }
    });
  } catch (error) {
    if (error.name === 'ZodError' || error.issues) {
      return next(new AppError(formatZodError(error), 400));
    }
    next(error);
  }
});

// PATCH /api/project-media/:mediaId/set-cover (Set as project cover image)
router.patch('/project-media/:mediaId/set-cover', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const media = await ProjectMediaRepository.setCover(req.params.mediaId);
    res.status(200).json({
      status: 'success',
      data: { media }
    });
  } catch (error) { next(error); }
});

// DELETE /api/project-media/:mediaId
router.delete('/project-media/:mediaId', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    await ProjectMediaRepository.delete(req.params.mediaId);
    res.status(204).json({
      status: 'success',
      data: null
    });
  } catch (error) { next(error); }
});

export default router;
