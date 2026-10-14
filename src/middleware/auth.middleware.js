import jwt from 'jsonwebtoken';
import { authorizeSectionRequest, isMatrixUser, hasSection, readKey } from './sectionAccess.js';
import { AppError } from '../shared/errors/errorHandler.js';
import { UsersRepository } from '../modules/users/users.repository.js';

export const protect = async (req, res, next) => {
  try {
    let token;
    
    if (req.cookies?.jwt) {
      token = req.cookies.jwt;
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('You are not logged in! Please log in to get access.', 401));
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super-secret-key-for-dev-only');

    // Check if user still exists
    const currentUser = await UsersRepository.findById(decoded.id);
    if (!currentUser) {
      return next(new AppError('The user belonging to this token does no longer exist.', 401));
    }

    if (!currentUser.is_active) {
      return next(new AppError('This user has been deactivated.', 401));
    }

    // Restricted finance profile: read finance, create only expense receipts.
    if (!currentUser.permissions?.includes('access.v2') && currentUser.permissions?.includes('finance.restricted')) {
      const path = String(req.originalUrl || '').split('?')[0].replace(/\/$/, '');
      const readOnly = ['GET', 'HEAD'].includes(req.method);
      const allowed = path.startsWith('/api/auth/') ||
        (readOnly && (path.startsWith('/api/finance/') || path === '/api/dictionaries' || path.startsWith('/api/dictionaries/') || path === '/api/deals' || path.startsWith('/api/deals/') || path === '/api/projects' || path.startsWith('/api/projects/'))) ||
        (req.method === 'POST' && path === '/api/finance/expenses');
      if (!allowed) return next(new AppError('Доступ разрешён только к просмотру финансов и оформлению РКО', 403));
    }

    // Grant access to protected route
    req.user = currentUser;
    await authorizeSectionRequest(req);
    next();
  } catch (error) {
    next(error instanceof AppError ? error : new AppError('Invalid token or authorization error', 401));
  }
};

export const protectOptional = async (req, res, next) => {
  try {
    let token;
    if (req.cookies?.jwt) {
      token = req.cookies.jwt;
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super-secret-key-for-dev-only');
      const currentUser = await UsersRepository.findById(decoded.id);
      if (currentUser && currentUser.is_active) {
        req.user = currentUser;
        await authorizeSectionRequest(req);
      }
    }
    next();
  } catch (error) {
    if (error instanceof AppError) return next(error);
    next();
  }
};

export const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (isMatrixUser(req.user) && req.sectionAccessGranted && ['GET','HEAD','POST','PUT','PATCH'].includes(req.method)) return next();
    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    next();
  };
};

export const checkPermission = (requiredPermission) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('You are not logged in', 401));
    }
    if (isMatrixUser(req.user)) {
      const key = requiredPermission.startsWith('sms.') ? 'automation.view' : readKey(requiredPermission);
      const write = requiredPermission === 'sms.send' || !['GET','HEAD'].includes(req.method);
      if (hasSection(req.user, key, write) || (requiredPermission === 'sms.send' && req.sectionAccessGranted && /\/preview$|\/template-availability$/.test(String(req.originalUrl || '')))) return next();
      return next(new AppError('Недостаточно прав доступа', 403));
    }
    if (req.user.role === 'ADMIN' || req.user.role === 'DIRECTOR') {
      return next();
    }
    const permissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (permissions.includes('*') || permissions.includes(requiredPermission)) {
      return next();
    }
    if (requiredPermission === 'sms.history' && (
      permissions.includes('sms.send') ||
      permissions.includes('sms.history') ||
      permissions.includes('sms.view') ||
      permissions.includes('leads.view') ||
      permissions.includes('leads.manage')
    )) {
      return next();
    }
    if (requiredPermission === 'sms.send' && (
      permissions.includes('sms.send') ||
      permissions.includes('leads.manage') ||
      permissions.includes('deals.manage')
    )) {
      return next();
    }
    return next(new AppError(`Недостаточно прав доступа (${requiredPermission})`, 403));
  };
};

