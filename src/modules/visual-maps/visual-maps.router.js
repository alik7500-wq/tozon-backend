import express from 'express';
import { VisualMapsRepository } from './visual-maps.repository.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';

const router = express.Router();
router.use(protect);

router.get('/projects/:projectId', async (req, res, next) => {
  try {
    const maps = await VisualMapsRepository.getByProjectId(req.params.projectId, req.query.kind);
    res.status(200).json({ status: 'success', data: { maps } });
  } catch (error) { next(error); }
});

router.post('/', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const visualMap = await VisualMapsRepository.createMap(req.body);
    res.status(201).json({ status: 'success', data: { visualMap } });
  } catch (error) { next(error); }
});

router.delete('/:id', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    await VisualMapsRepository.deleteMap(req.params.id);
    res.status(204).json({ status: 'success', data: null });
  } catch (error) { next(error); }
});

router.post('/:id/hotspots', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    await VisualMapsRepository.saveHotspots(req.params.id, req.body.hotspots);
    res.status(200).json({ status: 'success', data: null });
  } catch (error) { next(error); }
});

export default router;
