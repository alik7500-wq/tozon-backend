import express from 'express';
import { getServiceDB } from '../../db/connection.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const router = express.Router();
router.use(protect);
const codeOf = v => String(v || '').trim().toUpperCase();
const validPermissions = p => Array.isArray(p) && p.length <= 100 && p.every(x => typeof x === 'string' && x.length < 100) && !p.includes('*');

router.get('/', async (req,res,next) => {
  try {
    const {data,error} = await getServiceDB().from('crm_roles').select('code,name,description,permissions,is_system,is_active').order('name');
    if (error) throw error;
    res.json({status:'success',data:{roles:data}});
  } catch(e) { next(e); }
});

router.post('/', restrictTo('ADMIN','DIRECTOR'), async (req,res,next) => {
  try {
    const code = codeOf(req.body.code);
    const name = String(req.body.name || '').trim();
    const permissions = req.body.permissions || ['access.v2'];
    if (!/^[A-Z][A-Z0-9_]{1,49}$/.test(code) || name.length < 2 || name.length > 100 || !validPermissions(permissions))
      return next(new AppError('Некорректный код, название или права роли',400));
    const {data,error} = await getServiceDB().from('crm_roles').insert({code,name,description:String(req.body.description||'').slice(0,500),permissions:[...new Set(['access.v2',...permissions])]}).select().single();
    if (error) throw error;
    res.status(201).json({status:'success',data:{role:data}});
  } catch(e) { next(e); }
});

router.patch('/:code', restrictTo('ADMIN','DIRECTOR'), async (req,res,next) => {
  try {
    const code = codeOf(req.params.code);
    const db = getServiceDB();
    const {data:old,error:lookupError} = await db.from('crm_roles').select('*').eq('code',code).maybeSingle();
    if (lookupError) throw lookupError;
    if (!old) return next(new AppError('Роль не найдена',404));
    const updates = {updated_at:new Date().toISOString()};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (name.length < 2 || name.length > 100) return next(new AppError('Неверное название',400));
      updates.name = name;
    }
    if (req.body.description !== undefined) updates.description = String(req.body.description).slice(0,500);
    if (req.body.permissions !== undefined) {
      if (old.is_system) return next(new AppError('Системный шаблон нельзя изменять',403));
      if (!validPermissions(req.body.permissions)) return next(new AppError('Некорректные права',400));
      updates.permissions = [...new Set(['access.v2',...req.body.permissions])];
    }
    if (req.body.is_active !== undefined) {
      if (old.is_system) return next(new AppError('Системную роль нельзя отключить',403));
      if (!req.body.is_active) {
        const {count,error} = await db.from('users').select('id',{count:'exact',head:true}).eq('role',code);
        if (error) throw error;
        if (count) return next(new AppError('Роль используется сотрудниками',409));
      }
      updates.is_active = Boolean(req.body.is_active);
    }
    const {data,error} = await db.from('crm_roles').update(updates).eq('code',code).select().single();
    if (error) throw error;
    res.json({status:'success',data:{role:data}});
  } catch(e) { next(e); }
});
export default router;
