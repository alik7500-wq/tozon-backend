import jwt from 'jsonwebtoken';
import { AppError } from '../shared/errors/errorHandler.js';
import { UsersRepository } from '../modules/users/users.repository.js';

export const protect = async (req, res, next) => {
  try {
    let token;
    
    if (req.cookies.jwt) {
      token = req.cookies.jwt;
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

    // Grant access to protected route
    req.user = currentUser;
    next();
  } catch (error) {
    next(new AppError('Invalid token or authorization error', 401));
  }
};

export const restrictTo = (...roles) => {
  return (req, res, next) => {
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
    if (req.user.role === 'ADMIN') {
      return next();
    }
    const permissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (permissions.includes('*') || permissions.includes(requiredPermission)) {
      return next();
    }
    return next(new AppError(`Недостаточно прав доступа (${requiredPermission})`, 403));
  };
};
