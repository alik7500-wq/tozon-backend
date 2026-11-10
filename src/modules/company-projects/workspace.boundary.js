import jwt from 'jsonwebtoken';
import { UsersRepository } from '../users/users.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export const PROJECT_ONLY = 'company.project-only';
export const isProjectOnlyUser = user => user?.permissions?.includes(PROJECT_ONLY) === true;
const TEST_PROJECT_REF = 'yaolkwbnhnacxxjpgiyu';

export function assertWorkspacePilotRuntime(env = process.env) {
  if (env.PROJECT_WORKSPACE_ENABLED !== 'true') throw new AppError('Тестовое рабочее пространство пока выключено', 503);
  const configured = env.NODE_ENV === 'test' ? env.TEST_SUPABASE_URL : env.SUPABASE_URL;
  let hostname;
  try { hostname = new URL(configured).hostname; } catch { /* fail closed */ }
  if (hostname !== `${TEST_PROJECT_REF}.supabase.co`)
    throw new AppError('Пилотное рабочее пространство разрешено только на отдельной тестовой базе', 503);
}

// Mount before every CRM API and upload route. A scoped identity cannot bypass
// this boundary through a legacy ADMIN role, an old token, or an unknown endpoint.
export async function workspaceBoundary(req, res, next) {
  const path = String(req.originalUrl || '').split('?')[0];
  // Expired cookies must not prevent credential-based sign-in or clearing a session.
  if (req.method === 'POST' && ['/api/auth/login', '/api/auth/logout'].includes(path)) return next();
  // This one server-to-server route verifies its dedicated scheduler secret.
  // Treating that bearer secret as a CRM JWT breaks the existing cron. A real
  // CRM cookie still enters the scoped boundary and cannot use this exemption.
  if (req.method === 'POST' && path === '/api/internal/sms/payment-reminder/run' && !req.cookies?.jwt) return next();
  const token = req.cookies?.jwt || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token || token === 'loggedout') return next();
  try {
    if (!process.env.JWT_SECRET) throw new AppError('Authentication is not configured', 503);
    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { return next(new AppError('Недействительная сессия', 401)); }
    const user = await UsersRepository.findById(decoded.id);
    if (!user || !user.is_active) throw new AppError('Сессия недоступна', 401);
    req.boundaryUser = user;
    if (!isProjectOnlyUser(user)) return next();
    res.set('Cache-Control', 'no-store');
    const authRead = req.method === 'GET' && path === '/api/auth/me';
    if (authRead) return next();
    assertWorkspacePilotRuntime();
    const workspaceRead = req.method === 'GET' && /^\/api\/project-workspace(?:\/|$)/.test(path);
    const workspaceCommand = req.method === 'POST' && /^\/api\/project-workspace\/[0-9a-f-]{36}\/commands$/.test(path) && process.env.PROJECT_WORKSPACE_WRITES_ENABLED === 'true';
    const workspaceUpload = req.method === 'POST' && /^\/api\/project-workspace\/[0-9a-f-]{36}\/documents\/[1-9]\d{0,9}\/files$/.test(path) && process.env.PROJECT_WORKSPACE_WRITES_ENABLED === 'true' && process.env.PROJECT_WORKSPACE_DOCUMENTS_ENABLED === 'true' && process.env.PROJECT_WORKSPACE_FILES_ENABLED === 'true';
    if (!workspaceRead && !workspaceCommand && !workspaceUpload)
      throw new AppError('Для проектной учётной записи этот раздел или операция ещё не разрешены', 403);
    return next();
  } catch (error) { next(error); }
}
