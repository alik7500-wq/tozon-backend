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

// Server-side installment preview. Read-only: never creates deals, receipts or inventory changes.
router.post('/installment-preview', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) {
    return res.status(403).json({ message: 'RESETTLEMENT_WRITE_DENIED' });
  }
  const b = req.body ?? {};
  const { paid_area_x100: area, price_per_m2_minor: price, installment_months: months, first_payment_date: first } = b;
  if (!nonnegativeInt(area) || !nonnegativeInt(price) || !positiveInt(months) || months > 120 ||
      area > 100000000 || price > 100000000 ||
      typeof first !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(first)) {
    return res.status(400).json({ message: 'INVALID_INSTALLMENT_INPUT' });
  }
  const [year, month, day] = first.split('-').map(Number);
  const initial = new Date(Date.UTC(year, month - 1, day));
  if (initial.getUTCFullYear() !== year || initial.getUTCMonth() !== month - 1 ||
      initial.getUTCDate() !== day || year < 2000 || year > 2100) {
    return res.status(400).json({ message: 'INVALID_FIRST_PAYMENT_DATE' });
  }
  const totalMinor = Math.round(area * price / 100);
  if (!Number.isSafeInteger(totalMinor)) return res.status(400).json({ message: 'INVALID_INSTALLMENT_AMOUNT' });
  const eachMinor = Math.floor(totalMinor / months);
  const schedule = Array.from({ length: months }, (_, index) => {
    const base = new Date(Date.UTC(year, month - 1 + index, 1));
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    base.setUTCDate(Math.min(day, last));
    return { due_date: base.toISOString().slice(0, 10),
      amount_minor: index === months - 1 ? totalMinor - eachMinor * (months - 1) : eachMinor };
  });
  return res.json({ data: { payable_total_minor: totalMinor, currency: 'USD', schedule, persisted: false } });
});

// One action for the operator; the database performs all writes atomically.
router.post('/intake', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) {
    return res.status(403).json({ message: 'RESETTLEMENT_WRITE_DENIED' });
  }
  const b = req.body ?? {};
  const ids = ['project_id', 'unit_id', 'lead_id'];
  const areas = ['original_home_area_x100', 'compensated_area_x100', 'paid_area_x100', 'price_per_m2_minor'];
  if (!ids.every(k => positiveInt(b[k])) || !areas.every(k => nonnegativeInt(b[k])) ||
      !positiveInt(b.installment_months) || b.installment_months > 120 ||
      typeof b.first_payment_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.first_payment_date) ||
      typeof b.idempotency_key !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.idempotency_key)) {
    return res.status(400).json({ message: 'INVALID_INTAKE_INPUT' });
  }
  try {
    const { data, error } = await getServiceDB().rpc('create_resettlement_intake_atomic', {
      p_project_id: b.project_id, p_unit_id: b.unit_id, p_lead_id: b.lead_id,
      p_actor_id: Number(req.user.id),
      p_original_home_area_x100: b.original_home_area_x100,
      p_compensated_area_x100: b.compensated_area_x100,
      p_paid_area_x100: b.paid_area_x100,
      p_price_per_m2_minor: b.price_per_m2_minor,
      p_installment_months: b.installment_months,
      p_first_payment_date: b.first_payment_date,
      p_idempotency_key: b.idempotency_key
    });
    if (error) {
      const known = ['INVALID_ACTOR', 'INVALID_INTAKE', 'INVALID_TOTAL', 'IDEMPOTENCY_CONFLICT',
        'UNIT_UNAVAILABLE', 'AREA_MISMATCH', 'PROJECT_CURRENCY_MISMATCH', 'LEAD_NOT_FOUND',
        'ALREADY_ALLOCATED', 'UNIT_CHANGED'];
      if (known.includes(error.message)) return res.status(409).json({ message: error.message });
      throw error;
    }
    return res.status(data?.replayed ? 200 : 201).json({ data });
  } catch (error) {
    console.error('Resettlement intake failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

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
      b.compensated_area_x100 < b.original_home_area_x100 ||
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

// Read-only allocation validation. Signing and ledger changes are deliberately NOT performed.
router.post('/:id/allocation-preview', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return res.status(403).json({ message: 'RESETTLEMENT_WRITE_DENIED' });
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) return res.status(400).json({ message: 'INVALID_CASE_ID' });
  const allocations = req.body?.allocations;
  if (!Array.isArray(allocations) || allocations.length < 1 || allocations.length > 20 ||
      !allocations.every(x => positiveInt(x?.deal_id) && nonnegativeInt(x?.allocated_minor)) ||
      new Set(allocations.map(x => x.deal_id)).size !== allocations.length) {
    return res.status(400).json({ message: 'INVALID_ALLOCATION' });
  }
  try {
    const id = Number(req.params.id);
    const [c] = await read('resettlement_cases', 'id,status,payable_total_minor', 'id', id);
    if (!c) return res.status(404).json({ message: 'RESETTLEMENT_NOT_FOUND' });
    if (c.status !== 'APPROVED') return res.status(409).json({ message: 'RESETTLEMENT_NOT_APPROVED' });
    const links = await read('resettlement_case_units', 'deal_id', 'case_id', id);
    const ids = links.map(x => x.deal_id);
    if (ids.length !== allocations.length || ids.some(x => !allocations.some(a => a.deal_id === x))) {
      return res.status(409).json({ message: 'ALLOCATION_LINK_MISMATCH' });
    }
    const sum = allocations.reduce((total, x) => total + x.allocated_minor, 0);
    if (!Number.isSafeInteger(sum) || sum !== Number(c.payable_total_minor)) {
      return res.status(409).json({ message: 'ALLOCATION_TOTAL_MISMATCH', expected_minor: c.payable_total_minor });
    }
    const details = [];
    for (const a of allocations) {
      const [d] = await read('deals', 'id,status,final_price_minor,currency', 'id', a.deal_id);
      if (!d || d.currency !== 'USD') return res.status(409).json({ message: 'ALLOCATION_DEAL_CURRENCY_MISMATCH' });
      details.push({ deal_id: d.id, status: d.status, existing_contract_minor: d.final_price_minor, allocated_minor: a.allocated_minor, amendment_required: d.status === 'SIGNED' && Number(d.final_price_minor) !== a.allocated_minor });
    }
    return res.json({ data: { case_id: id, payable_total_minor: c.payable_total_minor, allocations: details, validated: true, saved: false, contract_signed: false } });
  } catch (error) {
    console.error('Resettlement allocation preview failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

router.get('/:id/signings', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
    return res.status(400).json({ message: 'INVALID_CASE_ID' });
  }
  try {
    const id = Number(req.params.id);
    const cases = await read('resettlement_cases', 'id', 'id', id);
    if (!cases.length) return res.status(404).json({ message: 'RESETTLEMENT_NOT_FOUND' });
    const { data, error } = await getServiceDB().from('resettlement_deal_signings')
      .select('id,deal_id,approval_id,signed_document_ref,signed_by,signed_at')
      .eq('case_id', id).order('signed_at', { ascending: false }).limit(100);
    if (error) throw error;
    return res.json({ data: data ?? [] });
  } catch (error) {
    console.error('Resettlement signing history failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

router.post('/:id/sign-deal', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return res.status(403).json({ message: 'RESETTLEMENT_WRITE_DENIED' });
  const { deal_id, approval_id, signed_document_ref } = req.body ?? {};
  if (!positiveInt(Number(req.params.id)) || !positiveInt(deal_id) || !positiveInt(approval_id) ||
      typeof signed_document_ref !== 'string' || signed_document_ref.trim().length < 3 || signed_document_ref.length > 500) {
    return res.status(400).json({ message: 'INVALID_SIGNING_REQUEST' });
  }
  try {
    const { data, error } = await getServiceDB().rpc('sign_resettlement_deal_atomic', {
      p_case_id: Number(req.params.id), p_deal_id: deal_id, p_actor_id: Number(req.user.id),
      p_approval_id: approval_id, p_signed_document_ref: signed_document_ref.trim()
    });
    if (error) {
      const known = ['INVALID_ACTOR','SIGNED_DOCUMENT_REQUIRED','CASE_NOT_APPROVED',
        'LATEST_APPROVAL_REQUIRED','ALLOCATION_INTEGRITY_FAILED','ALLOCATION_LINK_MISMATCH','CONTRACT_AMENDMENTS_REQUIRED',
        'DEAL_NOT_RESERVED','UNIT_NOT_RESERVED','DEAL_CHANGED','UNIT_CHANGED'];
      if (known.includes(error.message)) return res.status(409).json({ message: error.message });
      throw error;
    }
    return res.status(200).json({ data: { deal_id: data, signed: true } });
  } catch (error) {
    console.error('Resettlement deal signing failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

router.get('/:id/signing-readiness', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) return res.status(400).json({ message: 'INVALID_CASE_ID' });
  try {
    const id = Number(req.params.id);
    const cases = await read('resettlement_cases', 'id,status,payable_total_minor', 'id', id);
    if (!cases.length) return res.status(404).json({ message: 'RESETTLEMENT_NOT_FOUND' });
    const links = await read('resettlement_case_units', 'deal_id,unit_id', 'case_id', id);
    const { data: approvals, error } = await getServiceDB().from('resettlement_allocation_approvals')
      .select('id,approval_version,supporting_document_ref').eq('case_id', id)
      .order('approval_version', { ascending: false }).limit(1);
    if (error) throw error;
    const latest = approvals?.[0] ?? null;
    const allocations = latest ? await read('resettlement_allocation_lines', 'deal_id,allocated_minor', 'approval_id', latest.id) : [];
    const deals = await Promise.all(links.map(async link => {
      const found = await read('deals', 'id,contract_number,status,final_price_minor,currency', 'id', link.deal_id);
      const deal = found[0] ?? null;
      const allocated = allocations.find(a => Number(a.deal_id) === Number(link.deal_id));
      const blockers = [];
      if (!latest) blockers.push('ALLOCATION_NOT_APPROVED');
      if (!allocated) blockers.push('ALLOCATION_LINE_MISSING');
      if (!deal) blockers.push('DEAL_NOT_FOUND');
      if (deal?.currency !== 'USD') blockers.push('CURRENCY_MISMATCH');
      if (deal && allocated && Number(deal.final_price_minor) !== Number(allocated.allocated_minor)) blockers.push('CONTRACT_AMOUNT_REQUIRES_LEGAL_RECONCILIATION');
      return { deal_id: link.deal_id, contract_number: deal?.contract_number ?? null,
        status: deal?.status ?? null, contract_amount_minor: deal?.final_price_minor ?? null,
        approved_amount_minor: allocated?.allocated_minor ?? null, blockers };
    }));
    const blockers = [];
    if (cases[0].status !== 'APPROVED') blockers.push('CASE_NOT_APPROVED');
    if (!latest) blockers.push('ALLOCATION_NOT_APPROVED');
    const linkedIds = new Set(links.map(x => Number(x.deal_id)));
    const allocationIds = new Set(allocations.map(x => Number(x.deal_id)));
    if (allocations.length !== links.length ||
        linkedIds.size !== links.length ||
        allocationIds.size !== allocations.length ||
        [...linkedIds].some(dealId => !allocationIds.has(dealId)) ||
        [...allocationIds].some(dealId => !linkedIds.has(dealId)) ||
        allocations.some(a => !Number.isSafeInteger(Number(a.allocated_minor)) || Number(a.allocated_minor) < 0) ||
        allocations.reduce((sum, a) => sum + Number(a.allocated_minor), 0) !== Number(cases[0].payable_total_minor))
      blockers.push('ALLOCATION_INTEGRITY_FAILED');
    if (deals.some(d => d.blockers.length)) blockers.push('DEAL_RECONCILIATION_REQUIRED');
    return res.json({ data: { ready: blockers.length === 0, blockers, approval_version: latest?.approval_version ?? null, deals } });
  } catch (error) {
    console.error('Resettlement signing readiness failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

router.get('/:id/allocations', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) return res.status(400).json({ message: 'INVALID_CASE_ID' });
  try {
    const id = Number(req.params.id);
    const cases = await read('resettlement_cases', 'id', 'id', id);
    if (!cases.length) return res.status(404).json({ message: 'RESETTLEMENT_NOT_FOUND' });
    const { data, error } = await getServiceDB().from('resettlement_allocation_approvals')
      .select('id,approval_version,payable_total_minor,supporting_document_ref,approved_by,approved_at')
      .eq('case_id', id).order('approval_version', { ascending: false });
    if (error) throw error;
    const approvals = [];
    for (const approval of data ?? []) {
      const lines = await read('resettlement_allocation_lines', 'deal_id,allocated_minor', 'approval_id', approval.id);
      approvals.push({ ...approval, allocations: lines });
    }
    return res.json({ data: approvals });
  } catch (error) {
    console.error('Resettlement allocations read failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

router.post('/:id/approve-allocation', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return res.status(403).json({ message: 'RESETTLEMENT_WRITE_DENIED' });
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) return res.status(400).json({ message: 'INVALID_CASE_ID' });
  const allocations = req.body?.allocations;
  const documentRef = req.body?.supporting_document_ref;
  if (!Array.isArray(allocations) || allocations.length < 1 || allocations.length > 20 ||
      !allocations.every(a => positiveInt(a?.deal_id) && nonnegativeInt(a?.allocated_minor)) ||
      new Set(allocations.map(a => a.deal_id)).size !== allocations.length ||
      typeof documentRef !== 'string' || documentRef.trim().length < 3 || documentRef.length > 500) {
    return res.status(400).json({ message: 'INVALID_ALLOCATION_APPROVAL' });
  }
  try {
    const { data, error } = await getServiceDB().rpc('approve_resettlement_allocation', {
      p_case_id: Number(req.params.id),
      p_actor_id: Number(req.user.id),
      p_document_ref: documentRef.trim(),
      p_allocations: allocations
    });
    if (error) {
      const known = ['INVALID_ACTOR','INVALID_DOCUMENT_REF','INVALID_ALLOCATIONS',
        'RESETTLEMENT_NOT_FOUND','RESETTLEMENT_NOT_APPROVED','ALLOCATION_TOTAL_MISMATCH',
        'ALLOCATION_LINK_MISMATCH','ALLOCATION_CURRENCY_MISMATCH'];
      if (known.includes(error.message)) return res.status(409).json({ message: error.message });
      throw error;
    }
    return res.status(201).json({ data: { approval_id: data, saved: true, contract_signed: false } });
  } catch (error) {
    console.error('Resettlement allocation approval failed:', error?.code ?? error?.name ?? 'UNKNOWN');
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
    // Read-only payment snapshot; does not alter accounting records.
    const dealIds = [...new Set(linked.map(x => x.deal_id).filter(Boolean))];
    let paymentRows = [];
    if (dealIds.length) {
      const { data: payments, error: paymentsError } = await getServiceDB()
        .from('payments')
        .select('id,deal_id,amount_minor,currency,status,operation_type,settlement_method,payment_date,document_number,customer_pko_number')
        .in('deal_id', dealIds).order('id', { ascending: true });
      if (paymentsError) throw paymentsError;
      paymentRows = payments ?? [];
    }
    const active = paymentRows.filter(p => p.status === 'ACTIVE' && p.operation_type === 'STANDARD');
    const unsupported = active.filter(p => p.currency !== 'USD' || !Number.isSafeInteger(Number(p.amount_minor)));
    const usdPayments = active.filter(p => p.currency === 'USD' && Number.isSafeInteger(Number(p.amount_minor)));
    const cashReceivedMinor = usdPayments.filter(p => p.settlement_method === 'CASH')
      .reduce((sum, p) => sum + Number(p.amount_minor), 0);
    const nonCashCreditedMinor = usdPayments.filter(p => p.settlement_method !== 'CASH')
      .reduce((sum, p) => sum + Number(p.amount_minor), 0);
    const receivedTotalMinor = cashReceivedMinor + nonCashCreditedMinor;
    const financials = {
      cash_received_minor: cashReceivedMinor,
      non_cash_credited_minor: nonCashCreditedMinor,
      total_recorded_minor: receivedTotalMinor,
      preliminary_balance_minor: unsupported.length ? null : Number(cases[0].payable_total_minor) - receivedTotalMinor,
      balance_is_provisional: true,
      excluded_payment_count: unsupported.length,
      payments: paymentRows.map(p => ({
        id: p.id, deal_id: p.deal_id, payment_date: p.payment_date,
        amount_minor: p.amount_minor, currency: p.currency,
        status: p.status, operation_type: p.operation_type,
        settlement_method: p.settlement_method,
        document_number: p.document_number, customer_pko_number: p.customer_pko_number
      }))
    };
    const c = cases[0];
    const linkedArea = units.reduce((sum, u) => sum + Number(u.area_x100), 0);
    return res.json({ data: { ...c, units, linked_area_x100: linkedArea, financials, area_matches: linkedArea === c.compensated_area_x100 + c.paid_area_x100 } });
  } catch (error) {
    console.error('Resettlement read failed:', error?.code ?? error?.name ?? 'UNKNOWN');
    return res.status(503).json({ message: 'RESETTLEMENT_UNAVAILABLE' });
  }
});

export default router;
