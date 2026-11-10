import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/auth.middleware.js';
import { hasSection } from '../../middleware/sectionAccess.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { projectRegistry, saveCompanyProject } from './company-projects.repository.js';
import { parseCompanyProject } from './company-projects.validation.js';

const router = express.Router();
// Preparation registry only. This flag never enables access to business records.
router.use((req, res, next) => process.env.COMPANY_PROJECTS_ENABLED === 'true' ? next() : next(new AppError('Раздел проектов компании ещё не включён', 404)));
router.use(protect);
router.use((req, res, next) => {
  if (req.user.role !== 'ADMIN' || !hasSection(req.user, 'settings.view', true) || !hasSection(req.user, 'users.view', true))
    return next(new AppError('Реестр проектов доступен администратору компании с правом настройки и управления персоналом', 403));
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/', async (req, res, next) => {
  try { res.json({ status: 'success', data: await projectRegistry() }); } catch (e) { next(e); }
});
router.post('/', async (req, res, next) => {
  try { res.status(201).json({ status: 'success', data: { project: await saveCompanyProject(null, parseCompanyProject(req.body), req.user.id) } }); } catch (e) { next(e); }
});
router.put('/:id', async (req, res, next) => {
  try {
    if (!z.uuid().safeParse(req.params.id).success) throw new AppError('Некорректный проект', 400);
    res.json({ status: 'success', data: { project: await saveCompanyProject(req.params.id, parseCompanyProject(req.body, true), req.user.id) } });
  } catch (e) { next(e); }
});
export default router;
