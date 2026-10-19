import express from 'express';
import bcrypt from 'bcrypt';
import { UsersRepository } from './users.repository.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { getServiceDB } from '../../db/connection.js';
import { hasSection, isMatrixUser } from '../../middleware/sectionAccess.js';

const router = express.Router();
const CHIEF_ADMIN_EMAIL = 'admin@tozon.crm';
const isChiefAdmin = user => String(user?.email || '').trim().toLowerCase() === CHIEF_ADMIN_EMAIL;
const isProtectedChief = user => isChiefAdmin(user);
const chiefOnlyGuard = async (req, res, next) => {
  try {
    if (isChiefAdmin(req.user)) return next();
    const target = await UsersRepository.findById(req.params.id);
    if (isProtectedChief(target)) return next(new AppError('Учетная запись главного администратора недоступна', 403));
    next();
  } catch (error) { next(error); }
};

const manageUsers = (req, res, next) => {
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return next(new AppError('Управление сотрудниками разрешено только руководству', 403));
  if (isMatrixUser(req.user) && !hasSection(req.user, 'users.view', true)) return next(new AppError('Нет права изменения сотрудников и ролей', 403));
  return next();
};


router.use(protect);

// GET /api/users - List all users
router.get('/', async (req, res, next) => {
  try {
    const allUsers = await UsersRepository.findAll();
    const visibleUsers = isChiefAdmin(req.user) ? allUsers : allUsers.filter(user => !isProtectedChief(user));
    const users = String(req.query.lookup) === '1'
      ? visibleUsers.map(({ id, name, is_active }) => ({ id, name, is_active }))
      : visibleUsers;
    res.status(200).json({
      status: 'success',
      data: { users }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/users/:id - Get user by id
router.get('/:id', chiefOnlyGuard, async (req, res, next) => {
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

export const ROLE_PRESET_PERMISSIONS = {
  CASHIER: ['access.v2'],
  ADMIN: ['*'],
  DIRECTOR: [
    'analytics.view', 'analytics.reports',
    'inventory.view', 'inventory.manage',
    'leads.view', 'leads.manage',
    'deals.view', 'deals.manage',
    'contracts.view', 'contracts.manage',
    'finance.view', 'finance.payments', 'finance.expenses', 'finance.debtors', 'finance.cashflow',
    'tasks.manage', 'automation.manage', 'settings.manage',
    'sms.send', 'sms.history'
  ],
  SALES_MANAGER: [
    'inventory.view',
    'leads.view', 'leads.manage',
    'deals.view', 'deals.manage',
    'contracts.view',
    'tasks.manage',
    'sms.send', 'sms.history'
  ],
  WAREHOUSE_MANAGER: [
    'access.v2',
    'construction.stock',
    'construction.stock.write',
    'construction.advance',
    'construction.advance.write',
    'construction.settlements',
    'finance.expenses',
    'finance.expenses.write'
  ],
  MANAGER: [
    'inventory.view',
    'leads.view', 'leads.manage',
    'deals.view', 'deals.manage',
    'contracts.view',
    'tasks.manage',
    'sms.send', 'sms.history'
  ],
  FINANCE_MANAGER: [
    'analytics.view', 'analytics.reports',
    'inventory.view',
    'deals.view',
    'contracts.view', 'contracts.manage',
    'finance.view', 'finance.payments', 'finance.expenses', 'finance.debtors', 'finance.cashflow',
    'tasks.manage'
  ]
};

// POST /api/users - Create new user (ADMIN or DIRECTOR)
router.post('/', manageUsers, async (req, res, next) => {
  try {
    const { name, email, password, role, permissions, is_sales_rep } = req.body;

    if (!name || !email || !password) {
      return next(new AppError('Имя, Email и Пароль обязательны для заполнения', 400));
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = await UsersRepository.findByEmail(cleanEmail);
    if (existing) {
      return next(new AppError('Пользователь с таким Email уже существует', 400));
    }

    const userRole = String(role || 'SALES_MANAGER').trim().toUpperCase();
    if (!isChiefAdmin(req.user) && userRole === 'ADMIN') return next(new AppError('Назначение роли администратора недоступно', 403));
    const { data: roleEntry, error: roleError } = await getServiceDB().from('crm_roles').select('code,is_active,permissions').eq('code',userRole).maybeSingle();
    if (roleError) throw roleError;
    if (!roleEntry?.is_active) return next(new AppError('Роль не существует или отключена',400));

    const userPermissions = Array.isArray(permissions) && permissions.length > 0
      ? permissions
      : (roleEntry.permissions || []);

    const isSalesRep = is_sales_rep !== undefined
      ? Boolean(is_sales_rep)
      : (userRole === 'SALES_MANAGER');

    const password_hash = await bcrypt.hash(password, 10);
    const newUser = await UsersRepository.create({
      name: name.trim(),
      email: cleanEmail,
      password_hash,
      role: userRole,
      permissions: userPermissions,
      is_sales_rep: isSalesRep,
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
router.patch('/:id', manageUsers, chiefOnlyGuard, async (req, res, next) => {
  try {
    const { name, email, password, role, permissions, is_active, is_sales_rep } = req.body;
    const updates = {};
    if (name) updates.name = name.trim();
    if (email) updates.email = email.trim().toLowerCase();
    if (role) {
      const code = String(role).trim().toUpperCase();
      if (!isChiefAdmin(req.user) && code === 'ADMIN') return next(new AppError('Назначение роли администратора недоступно', 403));
      const { data: entry, error } = await getServiceDB().from('crm_roles').select('is_active').eq('code',code).maybeSingle();
      if (error) throw error;
      if (!entry?.is_active) return next(new AppError('Роль не существует или отключена',400));
      updates.role = code;
    }
    if (Array.isArray(permissions)) updates.permissions = permissions;
    if (typeof is_active !== 'undefined') updates.is_active = is_active ? 1 : 0;
    if (typeof is_sales_rep !== 'undefined') updates.is_sales_rep = Boolean(is_sales_rep);
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
router.delete('/:id', manageUsers, restrictTo('ADMIN'), chiefOnlyGuard, async (req, res, next) => {
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

