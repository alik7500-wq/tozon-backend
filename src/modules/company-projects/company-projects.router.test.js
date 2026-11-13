import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn() }));
vi.mock('./company-projects.repository.js', () => ({ projectRegistry: mocks.list, saveCompanyProject: mocks.save }));
vi.mock('../../middleware/auth.middleware.js', () => ({ protect: (req, res, next) => {
  const role = req.headers['x-test-role']; if (!role) return res.sendStatus(401);
  req.user = { id: 1, role, permissions: req.headers['x-test-limited'] ? ['access.v2', 'settings.view'] : [] }; next();
} }));
vi.mock('../../db/connection.js', () => ({ getServiceDB: vi.fn() }));
import router from './company-projects.router.js';
import { parseCompanyProject } from './company-projects.validation.js';
const app = express(); app.use(express.json()); app.use('/api/company-projects', router); app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
const valid = { name: 'Tozon Plaza', code: 'TOZON_PLAZA', partners: [{ name: 'Partner', share_percent: 50 }, { name: 'TOZON', share_percent: 50 }], complex_ids: [3,4] };
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('COMPANY_PROJECTS_ENABLED', 'true'); });
describe('company project administration', () => {
  it('fails closed when feature disabled and requires login when enabled', async () => {
    vi.stubEnv('COMPANY_PROJECTS_ENABLED', 'false'); expect((await request(app).get('/api/company-projects')).status).toBe(404);
    vi.stubEnv('COMPANY_PROJECTS_ENABLED', 'true'); expect((await request(app).get('/api/company-projects')).status).toBe(401); expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each(['DIRECTOR','MANAGER','CASHIER'])('rejects %s even for direct requests', async role => {
    for (const method of ['get', 'post', 'put']) {
      const req = request(app)[method]('/api/company-projects' + (method === 'put' ? '/ddac6e43-39b6-4f31-a872-aaf77e77d416' : ''));
      expect((await req.set('x-test-role', role).send(valid)).status).toBe(403);
    }
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('does not let a restricted administrator bypass personnel/settings write rights', async () => {
    expect((await request(app).get('/api/company-projects').set('x-test-role','ADMIN').set('x-test-limited','1')).status).toBe(403);
  });
  it('returns registry without caching to authorized administrator', async () => {
    mocks.list.mockResolvedValue({ projects: [], isolation_ready: false });
    const r = await request(app).get('/api/company-projects').set('x-test-role','ADMIN'); expect(r.status).toBe(200); expect(r.headers['cache-control']).toBe('no-store');
  });
  it('requires valid ID and revision on update, rejects forged ownership and activation fields', async () => {
    const id = 'ddac6e43-39b6-4f31-a872-aaf77e77d416';
    for (const [path, body] of [['bad-id',{...valid,revision:1}],[id,valid],[id,{...valid,revision:1,isolation_state:'ACTIVE'}],[id,{...valid,revision:1,company_id:id}]])
      expect((await request(app).put('/api/company-projects/'+path).set('x-test-role','ADMIN').send(body)).status).toBeGreaterThanOrEqual(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('passes authenticated actor and all data to one atomic save', async () => {
    mocks.save.mockResolvedValue({ revision: 1 });
    expect((await request(app).post('/api/company-projects').set('x-test-role','ADMIN').send(valid)).status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith(null, expect.objectContaining({name:'Tozon Plaza',complex_ids:[3,4]}), 1);
  });
  it('validates 100% total, duplicate partners/users/complexes and fractional shares', () => {
    for (const changes of [{ partners:[{name:'A',share_percent:50}] }, { partners:[{name:'A',share_percent:50},{name:'a',share_percent:50}] }, { complex_ids:[3,3] }, { members:[{user_id:2,project_role:'MANAGER'},{user_id:2,project_role:'PARTNER'}] }, { partners:[{name:'A',share_percent:33.333},{name:'B',share_percent:66.667}] }]) expect(() => parseCompanyProject({...valid,...changes})).toThrow();
  });
});
