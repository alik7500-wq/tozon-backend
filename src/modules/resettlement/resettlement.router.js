import express from 'express';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { getServiceDB } from '../../db/connection.js';

const router = express.Router();
router.use(protect);
router.use(restrictTo('ADMIN', 'DIRECTOR', 'FINANCE_MANAGER'));

const read = async (table, columns, filter, value) => {
  const { data, error } = await getServiceDB().from(table).select(columns).eq(filter, value);
  if (error) throw error;
  return data ?? [];
};

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
