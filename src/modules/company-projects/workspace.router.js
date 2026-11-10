import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { assertWorkspacePilotRuntime, isProjectOnlyUser } from './workspace.boundary.js';
import { readWorkspace, readWorkspaceOptions } from './workspace.repository.js';
import { parseWorkspaceCommand, executeWorkspaceCommand } from './workspace.commands.js';

const router = express.Router();
const resource = z.enum(['complexes', 'units', 'leads', 'deals', 'payments', 'schedules', 'expenses', 'warehouses']);
const pageSchema = z.object({ after: z.string().max(40).regex(/^(?:[0-9]{1,18}|[0-9a-f-]{36})?$/).optional(), limit: z.string().regex(/^\d{1,3}$/).transform(Number).refine(n => n >= 1 && n <= 100).optional() }).strict();
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('Некорректные параметры рабочего пространства', 400);
  return result.data;
}
router.use(protect);
router.use((req, res, next) => {
  try {
    if (!isProjectOnlyUser(req.user)) throw new AppError('Этот раздел предназначен для проектной учётной записи', 403);
    assertWorkspacePilotRuntime(); res.set('Cache-Control', 'no-store'); next();
  } catch (e) { next(e); }
});
router.get('/projects', async (req, res, next) => {
  try { parse(z.object({}).strict(), req.query); res.json({ status: 'success', data: await readWorkspace(req.user.id, null, 'projects') }); } catch (e) { next(e); }
});
router.post('/:project/commands', async (req, res, next) => {
  try {
    if (process.env.PROJECT_WORKSPACE_WRITES_ENABLED !== 'true') throw new AppError('Операции записи пилота ещё не включены', 403);
    // Cookie authentication requires an exact trusted browser origin. Bearer-only
    // callers must already hold the verified CRM token; a forged header cannot
    // bypass this check when a cookie is present.
    if (req.cookies?.jwt) {
      let allowed;
      try { allowed = new URL(process.env.FRONTEND_ORIGIN).origin; } catch { /* deny */ }
      if (!allowed || req.headers.origin !== allowed) throw new AppError('Недопустимый источник запроса', 403);
    }
    const project = parse(z.uuid(), req.params.project);
    const result = await executeWorkspaceCommand(req.user.id, project, parseWorkspaceCommand(req.body));
    res.status(result.idempotent ? 200 : 201).json({ status: 'success', data: result });
  } catch (e) { next(e); }
});
router.get('/:project/options{/:kind}', async (req, res, next) => {
  try {
    const project = parse(z.uuid(), req.params.project);
    const kind = parse(z.enum(['context','units','leads','deals','cash_desks','warehouses','parties','materials','complexes','schemes']), req.params.kind || 'context');
    const page = parse(pageSchema, req.query);
    if (kind === 'context' && Object.keys(page).length) throw new AppError('Параметры страницы не требуются', 400);
    const data = await readWorkspaceOptions(req.user.id, project, kind, page);
    if (kind === 'context' && process.env.PROJECT_WORKSPACE_WRITES_ENABLED !== 'true') data.commands = [];
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
});
router.get('/:project/:resource{/:record}', async (req, res, next) => {
  try {
    const project = parse(z.uuid(), req.params.project);
    const kind = parse(resource, req.params.resource);
    const page = parse(pageSchema, req.query);
    const record = req.params.record ? parse(kind === 'warehouses' ? z.uuid() : z.string().regex(/^[1-9]\d{0,17}$/), req.params.record) : null;
    if (record && Object.keys(page).length) throw new AppError('Параметры страницы недопустимы для отдельной записи', 400);
    res.json({ status: 'success', data: await readWorkspace(req.user.id, project, kind, { ...page, record }) });
  } catch (e) { next(e); }
});
router.use((req, res, next) => next(new AppError('Операция рабочего пространства не разрешена', 403)));
export default router;
