import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
const mocks = vi.hoisted(() => ({ user: { id: 1, role: 'ADMIN', permissions: [] }, rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../middleware/auth.middleware.js', () => ({ protect: (req, res, next) => { req.user = mocks.user; next(); } }));
vi.mock('../../db/connection.js', () => ({ getServiceDB: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
import router from './costs.router.js';
const app = express(); app.use(express.json()); app.use('/api/costs', router);
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
beforeEach(() => { vi.clearAllMocks(); mocks.user = { id: 1, role: 'ADMIN', permissions: [] }; });
describe('Cost API permissions and validation', () => {
  it('denies cash-only profiles before reading anything', async () => {
    mocks.user = { id: 2, role: 'FINANCE_MANAGER', permissions: ['finance.expenses'] };
    expect((await request(app).get('/api/costs/state')).status).toBe(403); expect(mocks.from).not.toHaveBeenCalled();
  });
  it('denies mutation for cost readers and write-only malformed profile', async () => {
    for (const permissions of [['finance.costs'], ['finance.costs.write']]) {
      mocks.user = { id: 2, permissions };
      expect((await request(app).put('/api/costs/allocations/1').send({})).status).toBe(403);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('binds actor to session and refuses injected actor/source amount fields', async () => {
    const body = { mode: 'DIRECT', building_ids: [3], reason: 'Rebar invoice', expected_version: 0 };
    expect((await request(app).put('/api/costs/allocations/1').send({ ...body, p_actor: 9 })).status).toBe(400);
    mocks.rpc.mockResolvedValue({ data: { expense_id: 1 } });
    expect((await request(app).put('/api/costs/allocations/1').send(body)).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('cost_save_allocation', expect.objectContaining({ p_actor: 1, p_expense: 1, p_expected: 0 }));
  });
  it('reports optimistic concurrency conflicts as 409', async () => {
    mocks.rpc.mockResolvedValue({ error: { message: 'VERSION_CONFLICT: Refresh' } });
    expect((await request(app).put('/api/costs/bases/3').send({ sellable_area_m2: 5000.5, reason: 'Confirmed schedule', expected_version: 0 })).status).toBe(409);
  });
  it('rejects invalid dates instead of widening the report', async () => {
    expect((await request(app).get('/api/costs/state?as_of=invalid')).status).toBe(400); expect(mocks.from).not.toHaveBeenCalled();
  });
  it('uses session actor for material usage and rejects arbitrary fields', async () => {
    const url='/api/costs/material-usages/00000000-0000-4000-8000-000000000001';
    const body={building_id:3,material_kind:'CONCRETE',stock_entry_id:4,reason:'Confirmed slab',expected_version:0};
    expect((await request(app).put(url).send({...body,p_actor:99})).status).toBe(400);
    mocks.rpc.mockResolvedValue({data:{id:'u1'}});
    expect((await request(app).put(url).send(body)).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('cost_save_material_usage',expect.objectContaining({p_actor:1,p_data:expect.objectContaining({building_id:3,material_kind:'CONCRETE'})}));
  });
  it('denies material mutations for read-only cost users', async () => {
    mocks.user={id:2,permissions:['finance.costs']};
    expect((await request(app).put('/api/costs/material-payments/00000000-0000-4000-8000-000000000001').send({})).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
