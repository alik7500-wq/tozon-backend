import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { rpc, from, authUser } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  authUser: { id: 3, role: 'ADMIN' }
}));

vi.mock('../../../middleware/auth.middleware.js', () => ({
  protect: (req, _res, next) => { req.user = authUser; next(); }
}));
vi.mock('../../../db/connection.js', () => ({
  getServiceDB: () => ({ rpc, from })
}));

import router from '../resettlement.router.js';

const app = express();
app.use(express.json());
app.use('/api/resettlements', router);

const valid = {
  project_id: 3,
  original_home_area_x100: 6880,
  compensated_area_x100: 9000,
  paid_area_x100: 3502,
  price_per_m2_minor: 40000,
  links: [{ unit_id: 92, deal_id: 27 }, { unit_id: 91, deal_id: 42 }]
};

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  authUser.role = 'ADMIN';
});

describe('resettlement API validation and permissions', () => {
  it('rejects compensation smaller than original area without database writes', async () => {
    const res = await request(app).post('/api/resettlements')
      .send({ ...valid, compensated_area_x100: 6800 });
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects malformed links without database writes', async () => {
    const res = await request(app).post('/api/resettlements')
      .send({ ...valid, links: [{ unit_id: 92, deal_id: 0 }] });
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('creates a draft using the expected atomic RPC payload', async () => {
    rpc.mockResolvedValue({ data: 17, error: null });
    const res = await request(app).post('/api/resettlements').send(valid);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: { id: 17, status: 'DRAFT' } });
    expect(rpc).toHaveBeenCalledWith('create_resettlement_draft', {
      p_project_id: 3,
      p_original_home_area_x100: 6880,
      p_compensated_area_x100: 9000,
      p_paid_area_x100: 3502,
      p_price_per_m2_minor: 40000,
      p_created_by: 3,
      p_links: valid.links
    });
  });

  it('prevents finance manager from creating or approving', async () => {
    authUser.role = 'FINANCE_MANAGER';
    const created = await request(app).post('/api/resettlements').send(valid);
    const approved = await request(app).post('/api/resettlements/17/approve').send({});
    expect(created.status).toBe(403);
    expect(approved.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('approves a draft through the approval RPC', async () => {
    rpc.mockResolvedValue({ data: 17, error: null });
    const res = await request(app).post('/api/resettlements/17/approve')
      .send({ note: 'Проверены основания переселения' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 17, status: 'APPROVED' });
    expect(rpc).toHaveBeenCalledWith('approve_resettlement_case', {
      p_case_id: 17,
      p_actor_id: 3,
      p_note: 'Проверены основания переселения'
    });
  });

  it('returns conflict for already linked apartment', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'ALREADY_LINKED' } });
    const res = await request(app).post('/api/resettlements').send(valid);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('ALREADY_LINKED');
  });
});
