import express from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { getServiceDB } from '../../db/connection.js';

const router = express.Router();
router.use(protect);
// Explicit role check: restrictTo permits section-matrix users on GET routes.
router.use((req, res, next) => {
  if (!['ADMIN', 'DIRECTOR', 'FINANCE_MANAGER'].includes(req.user?.role)) {
    return res.status(403).json({ message: 'RESETTLEMENT_ACCESS_DENIED' });
  }
  next();
});

const read = async (table, columns, filter, value) => {
  const { data, error } = await getServiceDB().from(table).select(columns).eq(filter, value);
  if (error) throw error;
  return data ?? [];
};

const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const nonnegativeInt = value => Number.isSafeInteger(value) && value >= 0;

router.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) {
    return res.status(403).json({ message: 'RESETTLEMENT_WRITE_DENIED' });
  }
  const b = req.body ?? {};
  const links = b.links;
  if (!positiveInt(b.project_id) || !nonnegativeInt(b.original_home_area_x100) ||
      !nonnegativeInt(b.compensated_area_x100) || !nonnegativeInt(b.paid_area_x100) ||
      !nonnegativeInt(b.price_per_m2_minor) ||
      !Array.isArray(links) || links.length < 1 || links.length > 20 ||
      !links.every(x => positiveInt(x?.unit_id) && positiveInt(x?.deal_id))) {
    return res.status(400).json({ message: 'INVALID_RESETTLEMENT_INPUT' });
  }
  try {
    const { data, error } = await getServiceDB().rpc('create_resettlement_draft', {
      p_project_id: b.project_id,
      p_original_home_area_x100: b.original_home_area_x100,
      p_compensated_area_x100: b.compensated_area_x100,
      p_paid_area_x100: b.paid_area_x100,
      p_price_per_m2_minor: b.price_per_m2_minor,
      p_created_by: Number(req.user.id),
      p_links: links.map(x => ({ unit_id: x.unit_id, deal_id: x.deal_id }))
    });
    if (error) {
      const known = ['INVALID_RESETTLEMENT_VALUES','INVALID_RESETTLEMENT_LINKS','INVALID_RESETTLEMENT_LINK',
        'INVALID_ACTOR','UNIT_NOT_FOUND','DEAL_UNIT_MISMATCH','DIFFERENT_BUYERS',
        'ALREADY_LINKED','DUPLICATE_LINK','AREA_MISMATCH'];
      if (known.includes(error.message)) return res.status(409).json({ message: error.message });
      throw error;
    }
    return res.status(201).json({ data: { id: data, status: 'DRAFT' } });
  } catch (error) {
    console.error('Resettlement creation failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const rawProject = req.query.project_id;
    if (rawProject !== undefined && !/^[1-9][0-9]*$/.test(String(rawProject))) {
      return res.status(400).json({ message: 'INVALID_PROJECT_ID' });
    }
    const pageSize = 50;
    const db = getServiceDB();
    let query = db.from('resettlement_cases')
      .select('id,project_id,original_home_area_x100,compensated_area_x100,paid_area_x100,payable_total_minor,status,created_at')
      .order('id', { ascending: false }).limit(pageSize);
    if (rawProject !== undefined) query = query.eq('project_id', Number(rawProject));
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ data: data ?? [], limit: pageSize });
  } catch (error) {
    console.error('Resettlement list failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

router.post('/:id/approve', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) {
    return res.status(403).json({ message: 'RESETTLEMENT_APPROVAL_DENIED' });
  }
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
    return res.status(400).json({ message: 'INVALID_CASE_ID' });
  }
  const note = req.body?.note;
  if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) {
    return res.status(400).json({ message: 'INVALID_APPROVAL_NOTE' });
  }
  try {
    const { data, error } = await getServiceDB().rpc('approve_resettlement_case', {
      p_case_id: Number(req.params.id),
      p_actor_id: Number(req.user.id),
      p_note: note ?? null
    });
    if (error) {
      const known = ['RESETTLEMENT_NOT_FOUND', 'RESETTLEMENT_NOT_DRAFT',
        'INVALID_APPROVER', 'RESETTLEMENT_APPROVAL_INTEGRITY_FAILED'];
      if (known.includes(error.message)) return res.status(409).json({ message: error.message });
      throw error;
    }
    return res.json({ data: { id: data, status: 'APPROVED' } });
  } catch (error) {
    console.error('Resettlement approval failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

router.get('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!/^[1-9][0-9]*$/.test(req.params.id)) return res.status(400).json({ message: 'INVALID_CASE_ID' });
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ message: 'INVALID_CASE_ID' });
    const cases = await read('resettlement_cases', 'id,project_id,original_home_area_x100,compensated_area_x100,compensated_extra_area_x100,paid_area_x100,price_per_m2_minor,payable_total_minor,status,approved_at,created_at', 'id', id);
    if (!cases.length) return res.status(404).json({ message: 'RESETTLEMENT_NOT_FOUND' });
    const linked = await read('resettlement_case_units', 'id,unit_id,deal_id,area_x100', 'case_id', id);
    const units = [];
    for (const item of linked) {
      const [unit] = await read('units', 'id,unit_number,area_m2_x100,status', 'id', item.unit_id);
      const deal = item.deal_id ? (await read('deals', 'id,contract_number,status,final_price_minor,currency', 'id', item.deal_id))[0] : null;
      units.push({ ...item, unit: unit ?? null, deal: deal ?? null });
    }
    const c = cases[0];
    const linkedArea = units.reduce((sum, u) => sum + Number(u.area_x100), 0);
    return res.json({ data: { ...c, units, linked_area_x100: linkedArea, area_matches: linkedArea === c.compensated_area_x100 + c.paid_area_x100 } });
  } catch (error) {
    console.error('Resettlement read failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

export default router;
