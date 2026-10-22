import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
vi.mock('../../../middleware/auth.middleware.js', () => ({ protect: (req, res, next) => { req.user = { id: 1, role: 'ADMIN' }; next(); }, restrictTo: () => (req, res, next) => next() }));
vi.mock('../../../middleware/cashDeskAuth.middleware.js', () => ({ resolveCashDeskAccess: vi.fn((req, res, next) => { req.cashDeskAccess = access; next(); }) }));
vi.mock('../deals.repository.js', () => ({ DealsRepository: { createDeal: vi.fn() } }));
vi.mock('../../tasks/tasks.service.js', () => ({ TasksService: { onDealCreated: vi.fn() } }));
vi.mock('../../dictionaries/dictionaries.repository.js', () => ({ DictionariesRepository: { getItems: vi.fn() } }));
import router from '../deals.router.js';
import { DealsRepository } from '../deals.repository.js';
import { DictionariesRepository } from '../../dictionaries/dictionaries.repository.js';
import { resolveCashDeskAccess } from '../../../middleware/cashDeskAuth.middleware.js';
let access;
const body = { lead_id: 1, unit_id: 2, status: 'SIGNED', final_price_minor: 100000, down_payment_minor: 30000, record_initial_payment: true, initial_payment_cash_desk_id: 'desk-a' };
const app = express(); app.use(express.json()); app.use('/deals', router); app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
beforeEach(() => {
 vi.clearAllMocks();
 access = { canCreateIncome: true, allWritableDesks: false, incomeDeskIds: ['desk-a'] };
 DictionariesRepository.getItems.mockResolvedValue([{ id: 'desk-a', is_active: true }, { id: 'inactive', is_active: false }]);
 DealsRepository.createDeal.mockResolvedValue({ id: 10 });
});
describe('validate initial receipt destination before creating sale', () => {
 it('passes the validated desk into both repository keys', async () => {
  const res = await request(app).post('/deals').send({ ...body, cash_desk_id: 'unapproved-other-desk' });
  expect(res.status).toBe(201);
  expect(DealsRepository.createDeal).toHaveBeenCalledWith(expect.objectContaining({ initial_payment_cash_desk_id: 'desk-a', cash_desk_id: 'desk-a' }), 1);
 });
 it('supports legacy cash_desk_id as the same validated destination', async () => {
  const res = await request(app).post('/deals').send({ ...body, initial_payment_cash_desk_id: null, cash_desk_id: 'desk-a' });
  expect(res.status).toBe(201);
 });
 it('rejects missing selection before any contract writes', async () => {
  const res = await request(app).post('/deals').send({ ...body, initial_payment_cash_desk_id: null });
  expect(res.status).toBe(400); expect(DealsRepository.createDeal).not.toHaveBeenCalled();
 });
 it.each([{ canCreateIncome: false, allWritableDesks: true }, { canCreateIncome: true, incomeDeskIds: ['other'] }, null])('rejects unavailable income permissions %j', async permissions => {
  access = permissions;
  const res = await request(app).post('/deals').send(body);
  expect(res.status).toBe(403); expect(DealsRepository.createDeal).not.toHaveBeenCalled();
 });
 it.each(['inactive', 'unknown'])('rejects %s desk even for administrator', async id => {
  access = { canCreateIncome: true, allWritableDesks: true };
  const res = await request(app).post('/deals').send({ ...body, initial_payment_cash_desk_id: id });
  expect(res.status).toBe(400); expect(DealsRepository.createDeal).not.toHaveBeenCalled();
 });
 it.each([{ record_initial_payment: false }, { status: 'RESERVED' }, { down_payment_minor: 0 }])('leaves non-receipt sales independent of cash desk access: %j', async overrides => {
  const res = await request(app).post('/deals').send({ ...body, ...overrides, initial_payment_cash_desk_id: null });
  expect(res.status).toBe(201); expect(resolveCashDeskAccess).not.toHaveBeenCalled();
  expect(DictionariesRepository.getItems).not.toHaveBeenCalled();
 });
 it('does not create a sale when cash desk lookup fails', async () => {
  DictionariesRepository.getItems.mockRejectedValue(new Error('Unavailable'));
  expect((await request(app).post('/deals').send(body)).status).toBe(500);
  expect(DealsRepository.createDeal).not.toHaveBeenCalled();
 });
});
