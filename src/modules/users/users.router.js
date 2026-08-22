import express from 'express';
import bcrypt from 'bcrypt';
import { UsersRepository } from './users.repository.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const router = express.Router();

router.use(protect);

// GET /api/users - List all users
router.get('/', async (req, res, next) => {
  try {
    const users = await UsersRepository.findAll();
    res.status(200).json({
      status: 'success',
      data: { users }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/users/:id - Get user by id
router.get('/:id', async (req, res, next) => {
  try {
    const user = await UsersRepository.findById(req.params.id);
    if (!user) {
      return next(new AppError('Пользователь не найден', 404));
    }
    res.status(200).json({
      status: 'success',
      data: { user }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/users - Create new user (ADMIN or DIRECTOR)
router.post('/', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return next(new AppError('Имя, Email и Пароль обязательны для заполнения', 400));
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = await UsersRepository.findByEmail(cleanEmail);
    if (existing) {
      return next(new AppError('Пользователь с таким Email уже существует', 400));
    }

    const validRoles = ['ADMIN', 'DIRECTOR', 'SALES_MANAGER', 'FINANCE_MANAGER', 'MANAGER'];
    const userRole = validRoles.includes(role) ? role : 'SALES_MANAGER';

    const password_hash = await bcrypt.hash(password, 10);
    const newUser = await UsersRepository.create({
      name: name.trim(),
      email: cleanEmail,
      password_hash,
      role: userRole,
      is_active: 1
    });

    res.status(201).json({
      status: 'success',
      message: 'Пользователь успешно создан',
      data: { user: newUser }
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/users/:id - Update user
router.patch('/:id', restrictTo('ADMIN', 'DIRECTOR'), async (req, res, next) => {
  try {
    const { name, email, password, role, is_active } = req.body;
    const updates = {};
    if (name) updates.name = name.trim();
    if (email) updates.email = email.trim().toLowerCase();
    if (role) updates.role = role;
    if (typeof is_active !== 'undefined') updates.is_active = is_active ? 1 : 0;
    if (password) {
      updates.password_hash = await bcrypt.hash(password, 10);
    }

    const updatedUser = await UsersRepository.update(req.params.id, updates);
    res.status(200).json({
      status: 'success',
      data: { user: updatedUser }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/users/:id - Delete user
router.delete('/:id', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    if (String(req.user.id) === String(req.params.id)) {
      return next(new AppError('Вы не можете удалить свою учетную запись', 400));
    }
    await UsersRepository.delete(req.params.id);
    res.status(200).json({
      status: 'success',
      message: 'Пользователь успешно удален'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
