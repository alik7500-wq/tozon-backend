import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { AppError } from '../../shared/errors/errorHandler.js';
import { UsersRepository } from '../users/users.repository.js';

const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'super-secret-key-for-dev-only', {
    expiresIn: process.env.JWT_EXPIRES_IN || '90d'
  });
};

export const createSendToken = (user, statusCode, res) => {
  const token = signToken(user.id);
  
  const cookieOptions = {
    expires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
    httpOnly: true,
    sameSite: 'none',
    secure: true
  };

  res.cookie('jwt', token, cookieOptions);

  // Remove password from output
  user.password_hash = undefined;

  res.status(statusCode).json({
    status: 'success',
    token,
    data: {
      user
    }
  });
};

export const login = async (email, password, res) => {
  if (!email || !password) {
    throw new AppError('Please provide email and password!', 400);
  }

  const user = await UsersRepository.findByEmail(email);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new AppError('Incorrect email or password', 401);
  }

  if (!user.is_active) {
    throw new AppError('User is deactivated', 401);
  }

  createSendToken(user, 200, res);
};

export const logout = (res) => {
  res.cookie('jwt', 'loggedout', {
    expires: new Date(Date.now() + 10 * 1000), // 10 seconds
    httpOnly: true,
    sameSite: 'none',
    secure: true
  });
  res.status(200).json({ status: 'success' });
};
