import { Router } from 'express';
import { z } from 'zod';
import { getServiceDB } from '../../db/connection.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { buildCostReport, canReadCosts, canWriteCosts } from './costs.service.js';

const router = Router();
const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
const checked = r => { if (r.error) throw new AppError(r.error.message, r.error.message?.includes('VERSION_CONFLICT') ? 409 : 400); return r.data; };
const parse = (schema, value) => { const r = schema.safeParse(value); if (!r.success) throw new AppError('Проверьте параметры: ' + r.error.issues.map(e => e.message).join('; '), 400); return r.data; };
const id = z.coerce.number().int().positive();
const version = z.number().int().nonnegative();
const all = async (db, table, columns = '*') => {
  const data = [];
  for (let i = 0; ; i += 500) { const rows = checked(await db.from(table).select(columns).order('id').range(i, i + 499)); data.push(...rows); if (rows.length < 500) return data; }
};
// Tables without an id column have building_id / expense_id primary keys.
const keyedAll = async (db, table, key) => {
  const data = [];
  for (let i = 0; ; i += 500) { const rows = checked(await db.from(table).select('*').order(key).range(i, i + 499)); data.push(...rows); if (rows.length < 500) return data; }
};
router.use(protect);
router.use((req, res, next) => canReadCosts(req.user) ? next() : next(new AppError('Нет доступа к себестоимости блоков', 403)));
router.get('/state', wrap(async (req, res) => {
  const asOf = parse(z.iso.date(), req.query.as_of || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dushanbe' }));
  const db = getServiceDB();
  const [buildings, projects, sections, floors, units, bases, expenses, allocations, advances] = await Promise.all([
    all(db, 'buildings', 'id,project_id,name,archived_at'), all(db, 'projects', 'id,name,archived_at'),
    all(db, 'sections', 'id,building_id,archived_at'), all(db, 'floors', 'id,section_id,archived_at'),
    all(db, 'units', 'id,floor_id,area_m2_x100,archived_at'), keyedAll(db, 'cost_building_bases', 'building_id'),
    all(db, 'expenses', 'id,amount_minor,currency,expense_date,category,description,reference,amount_usd,exchange_rate,operation_type,status,voided_at,transfer_id,conversion_id,conversion_expense_id'),
    keyedAll(db, 'cost_expense_allocations', 'expense_id'), all(db, 'construction_documents', 'id,kind,status,expense_id')
  ]);
  // Archived blocks remain in reports so their recorded expenditure cannot disappear.
  const sectionBlocks = new Map(sections.filter(s => !s.archived_at).map(s => [s.id, s.building_id]));
  const floorBlocks = new Map(floors.filter(f => !f.archived_at).map(f => [f.id, sectionBlocks.get(f.section_id)]));
  const registry = {};
  for (const u of units.filter(u => !u.archived_at)) { const b = floorBlocks.get(u.floor_id); if (!b) continue; registry[b] ||= { area: 0, count: 0 }; registry[b].area += Number(u.area_m2_x100 || 0) / 100; registry[b].count++; }
  const report = buildCostReport({ buildings, bases, registry, expenses, allocations, advances, asOf });
  res.json({ data: { ...report, projects, can_write: canWriteCosts(req.user) } });
}));
router.use((req, res, next) => canWriteCosts(req.user) ? next() : next(new AppError('Нет права изменения себестоимости', 403)));
router.put('/bases/:id', wrap(async (req, res) => {
  const body = parse(z.object({ sellable_area_m2: z.number().positive().max(10000000).multipleOf(0.01), reason: z.string().trim().min(3).max(2000), expected_version: version }).strict(), req.body);
  res.json({ data: checked(await getServiceDB().rpc('cost_save_basis', { p_building: parse(id, req.params.id), p_area: body.sellable_area_m2, p_reason: body.reason, p_expected: body.expected_version, p_actor: req.user.id })) });
}));
router.put('/allocations/:id', wrap(async (req, res) => {
  const body = parse(z.object({ mode: z.enum(['DIRECT', 'SHARED', 'EXCLUDED', 'UNASSIGNED']), building_ids: z.array(id).max(100).default([]), reason: z.string().trim().min(3).max(2000), expected_version: version }).strict(), req.body);
  res.json({ data: checked(await getServiceDB().rpc('cost_save_allocation', { p_expense: parse(id, req.params.id), p_mode: body.mode, p_buildings: body.building_ids, p_reason: body.reason, p_expected: body.expected_version, p_actor: req.user.id })) });
}));
export default router;
