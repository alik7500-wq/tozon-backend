import { beforeEach, describe, expect, it, vi } from 'vitest';
const { from, protect } = vi.hoisted(() => ({
  from: vi.fn(),
  protect: vi.fn((req, _res, next) => { req.user = { id: 1, role: 'ADMIN' }; next(); })
}));
vi.mock('../middleware/auth.middleware.js', () => ({ protect }));
vi.mock('../db/connection.js', () => ({ getServiceDB: () => ({ from }) }));
import express from 'express';
import request from 'supertest';
import router from '../modules/integrations/instagram-assignments.router.js';
const app = express();
app.use(express.json());
app.use('/assignments', router);
const path = '/assignments/17841447499018452/123456789';
describe('Instagram conversation assignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INSTAGRAM_ASSIGNMENTS_ENABLED;
    delete process.env.INSTAGRAM_TOZON_TENANT_ID;
    process.env.INSTAGRAM_INBOX_ACCOUNT_ID = '17841447499018452';
    protect.mockImplementation((req, _res, next) => { req.user = { id: 1, role: 'ADMIN' }; next(); });
  });
  it('denies by default without database access', async () => {
    const response = await request(app).post(path).send({ managerId: 2 });
    expect(response.status).toBe(503);
    expect(from).not.toHaveBeenCalled();
  });
  it('denies non-administrators', async () => {
    process.env.INSTAGRAM_ASSIGNMENTS_ENABLED = 'true';
    protect.mockImplementation((req, _res, next) => { req.user = { id: 2, role: 'SALES_MANAGER' }; next(); });
    const response = await request(app).post(path).send({ managerId: 2 });
    expect(response.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });
  it('rejects malformed input and other accounts before database access', async () => {
    process.env.INSTAGRAM_ASSIGNMENTS_ENABLED = 'true';
    expect((await request(app).post(path).send({ managerId: '2' })).status).toBe(400);
    expect((await request(app).post('/assignments/17841447499018453/123456789').send({ managerId: 2 })).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });
  it('rejects inactive managers', async () => {
    process.env.INSTAGRAM_ASSIGNMENTS_ENABLED = 'true';
    from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 2, role: 'SALES_MANAGER', is_active: 0 }, error: null }) }) }) });
    const response = await request(app).post(path).send({ managerId: 2 });
    expect(response.status).toBe(422);
  });
  it('rejects other active staff roles', async () => {
    process.env.INSTAGRAM_ASSIGNMENTS_ENABLED = 'true';
    from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 2, role: 'FINANCE_MANAGER', is_active: 1 }, error: null }) }) }) });
    const response = await request(app).post(path).send({ managerId: 2 });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('INVALID_MANAGER');
  });
  it('requires configured tenant before saving an assignment', async () => {
    process.env.INSTAGRAM_ASSIGNMENTS_ENABLED = 'true';
    from.mockImplementation(table => table === 'users'
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 2, role: 'SALES_MANAGER', is_active: 1 }, error: null }) }) }) }
      : { select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [{ message_id: 'm1' }], error: null }) }) }) }) });
    const response = await request(app).post(path).send({ managerId: 2 });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('INSTAGRAM_TENANT_NOT_CONFIGURED');
  });
});
