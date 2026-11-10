import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const mocks = vi.hoisted(() => ({ findUser: vi.fn() }));
vi.mock('../users/users.repository.js', () => ({ UsersRepository: { findById: mocks.findUser } }));
import { workspaceBoundary, assertWorkspacePilotRuntime } from './workspace.boundary.js';
const secret = 'synthetic-workspace-test-secret-only';
const token = () => jwt.sign({ id: 20 }, secret, { expiresIn: '5m' });
const pilot = { id: 20, role: 'ADMIN', is_active: 1, permissions: ['company.project-only'] };
const app = express(); app.use(cookieParser()); app.use(['/api', '/uploads'], workspaceBoundary); app.use((req,res) => res.json({reached:true})); app.use((e,req,res,next) => res.status(e.statusCode || 500).json({message:e.message}));
beforeEach(() => { vi.stubEnv('JWT_SECRET',secret); vi.stubEnv('PROJECT_WORKSPACE_ENABLED','true'); vi.stubEnv('TEST_SUPABASE_URL','https://yaolkwbnhnacxxjpgiyu.supabase.co'); mocks.findUser.mockReset().mockResolvedValue(pilot); });
describe('project-only API boundary', () => {
  it.each(['/api/deals/999','/api/leads','/api/finance/income','/api/search','/api/reports/export','/api/document-settings/render/1','/api/company-projects','/api/future-module','/uploads/contract.pdf'])('blocks direct legacy route %s even with ADMIN role', async path => {
    expect((await request(app).get(path).set('Authorization','Bearer '+token())).status).toBe(403);
  });
  it.each(['post','put','patch','delete'])('denies workspace mutation with %s', async method => {
    expect((await request(app)[method]('/api/project-workspace/anything').set('Authorization','Bearer '+token())).status).toBe(403);
  });
  it('allows only workspace reads, authentication profile and sign-out', async () => {
    expect((await request(app).get('/api/project-workspace/projects').set('Authorization','Bearer '+token())).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie','jwt='+token())).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').set('Cookie','jwt='+token())).status).toBe(200);
  });
  it('keeps project-only identity locked out of legacy data when flag is disabled or production URL is configured', async () => {
    vi.stubEnv('PROJECT_WORKSPACE_ENABLED','false');
    expect((await request(app).get('/api/deals').set('Authorization','Bearer '+token())).status).toBe(503);
    vi.stubEnv('PROJECT_WORKSPACE_ENABLED','true'); vi.stubEnv('TEST_SUPABASE_URL','https://yeslzrrcwgcqfxhgbrqk.supabase.co');
    expect((await request(app).get('/api/project-workspace/projects').set('Authorization','Bearer '+token())).status).toBe(503);
  });
  it('does not trust role or project claims from a previously issued JWT', async () => {
    const old = jwt.sign({id:20,role:'ADMIN',project_id:'forged'},secret);
    expect((await request(app).get('/api/deals').set('Authorization','Bearer '+old)).status).toBe(403);
    mocks.findUser.mockResolvedValue({...pilot,is_active:0});
    expect((await request(app).get('/api/project-workspace/projects').set('Authorization','Bearer '+old)).status).toBe(401);
  });
  it('preserves ordinary existing users and permits re-login with expired cookies', async () => {
    mocks.findUser.mockResolvedValue({...pilot,permissions:[]});
    expect((await request(app).get('/api/deals').set('Authorization','Bearer '+token())).status).toBe(200);
    expect((await request(app).post('/api/auth/login').set('Cookie','jwt=expired-cookie')).status).toBe(200);
  });
  it('checks exact test database hostname rather than substring', () => {
    expect(() => assertWorkspacePilotRuntime({PROJECT_WORKSPACE_ENABLED:'true',SUPABASE_URL:'https://yaolkwbnhnacxxjpgiyu.supabase.co.attacker.invalid'})).toThrow();
  });
});
