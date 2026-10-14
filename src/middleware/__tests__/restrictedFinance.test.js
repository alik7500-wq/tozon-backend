import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../db/connection.js', () => ({ getDB: vi.fn(), getServiceDB: vi.fn() }));
vi.mock('../../modules/users/users.repository.js', () => ({ UsersRepository: { findById: vi.fn() } }));
vi.mock('jsonwebtoken', () => ({ default: { verify: vi.fn(() => ({ id: 4 })) } }));
import { getDB, getServiceDB } from '../../db/connection.js';
import { UsersRepository } from '../../modules/users/users.repository.js';
import { protect } from '../auth.middleware.js';
import { resolveCashDeskAccess, requireCashDeskExpense, requireCashDeskIncome, requireCashDeskMutation, requireCashTransferPermission } from '../cashDeskAuth.middleware.js';
const user = { id: 4, role: 'FINANCE_MANAGER', is_active: 1, permissions: ['finance.view', 'finance.expenses', 'finance.restricted'] };
const records = [
  { cash_desk_id: 'akmal', can_view: true, can_create_expense: false },
  { cash_desk_id: 'ilhom', can_view: true, can_create_income: false, can_create_expense: true, can_edit: false, can_void: false, can_delete: false }
];
beforeEach(() => {
  UsersRepository.findById.mockResolvedValue(user);
  getDB.mockReturnValue({ from: () => { throw new Error("public client must not read permission table"); } });
  getServiceDB.mockReturnValue({ from: () => ({ select: () => ({ eq: async () => ({ data: records }) }) }) });
});
describe('restricted finance profile', () => {
  it.each([
    ['GET', '/api/finance/cashflow', true], ['GET', '/api/deals', true],
    ['POST', '/api/finance/expenses', true], ['POST', '/api/finance/income', false],
    ['PATCH', '/api/finance/expenses/1', false], ['DELETE', '/api/finance/expenses/1', false],
    ['POST', '/api/finance/convert', false], ['POST', '/api/finance/transfers', false],
    ['GET', '/api/construction/materials', false], ['GET', '/api/users', false],
    ['POST', '/api/deals/1/payments', false]
  ])('authorizes %s %s correctly', async (method, originalUrl, allowed) => {
    const next = vi.fn();
    await protect({ method, originalUrl, headers: { authorization: 'Bearer test' } }, {}, next);
    if (allowed) expect(next).toHaveBeenCalledWith();
    else expect(next.mock.calls[0][0].statusCode).toBe(403);
  });
  it('allows global finance reads but scopes all writes to the assigned expense desk', async () => {
    const req = { user, method: 'POST', query: {}, body: { cash_desk_id: 'ilhom' } };
    const next = vi.fn();
    await resolveCashDeskAccess(req, {}, next);
    expect(req.cashDeskAccess.isAdmin).toBe(false);
    expect(req.cashDeskAccess.cashDeskId).toBe('ilhom');
    expect(req.cashDeskAccess.expenseDeskIds).toEqual(['ilhom']);
    const allowed = vi.fn(); requireCashDeskExpense(req, {}, allowed);
    expect(allowed).toHaveBeenCalledWith();
    for (const guard of [requireCashDeskIncome, requireCashDeskMutation, requireCashTransferPermission]) {
      const denied = vi.fn(); guard(req, {}, denied);
      expect(denied.mock.calls[0][0].statusCode).toBe(403);
    }
    req.body.cash_desk_id = 'akmal';
    const denied = vi.fn(); requireCashDeskExpense(req, {}, denied);
    expect(denied.mock.calls[0][0].statusCode).toBe(403);
    req.method = 'GET';
    await resolveCashDeskAccess(req, {}, vi.fn());
    expect(req.cashDeskAccess.isAdmin).toBe(true);
    expect(req.cashDeskAccess.canCreateIncome).toBe(false);
  });
  it('preserves existing admin and unrestricted financial manager profiles', async () => {
    for (const role of ['ADMIN', 'FINANCE_MANAGER']) {
      const req = { user: { id: 1, role, permissions: [] }, method: 'POST', query: {} };
      await resolveCashDeskAccess(req, {}, vi.fn());
      expect(req.cashDeskAccess.isAdmin).toBe(true);
    }
  });
});

describe('matrix permissions take precedence over legacy finance-only section restriction', () => {
  it.each([
    ['GET','/api/leads',true], ['GET','/api/projects/3',true],
    ['GET','/api/reports/analytics-1',true], ['GET','/api/users',true],
    ['POST','/api/leads',false], ['GET','/api/construction/state',false],
    ['POST','/api/sms/send',false], ['POST','/api/finance/expenses',true]
  ])('%s %s follows explicit permissions',async(method,originalUrl,allowed)=>{
    UsersRepository.findById.mockResolvedValue({...user,permissions:[
      'access.v2','finance.restricted','analytics.view','analytics.reports','inventory.view',
      'leads.view','tasks.view','deals.view','contracts.view','users.view',
      'finance.view','finance.payments','finance.payments.write','finance.expenses','finance.expenses.write','finance.cashflow'
    ]});
    const next=vi.fn();
    await protect({method,originalUrl,headers:{authorization:'Bearer test'},query:{},body:{}},{},next);
    if(allowed)expect(next).toHaveBeenCalledWith();
    else expect(next.mock.calls[0][0].statusCode).toBe(403);
  });
});


describe('cash access lookup failures', () => {
  it('reports database errors instead of claiming no permissions', async () => {
    getServiceDB.mockReturnValue({ from: () => ({ select: () => ({ eq: async () => ({ data: null, error: new Error('denied') }) }) }) });
    const next = vi.fn();
    await resolveCashDeskAccess({user,method:'GET',query:{}}, {}, next);
    expect(next.mock.calls[0][0].statusCode).toBe(503);
  });
});
