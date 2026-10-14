import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db/connection.js', () => ({ getServiceDB: vi.fn() }));
import { getServiceDB } from '../../db/connection.js';
import { authorizeSectionRequest } from '../sectionAccess.js';
const req = (method,path,permissions,body={}) => ({method,originalUrl:path,user:{role:'FINANCE_MANAGER',permissions:['access.v2',...permissions]},body});
const routes = [
 ['finance.payments','finance.payments.write','/api/finance/income'],
 ['finance.expenses','finance.expenses.write','/api/finance/expenses'],
 ['finance.view','finance.view.write','/api/finance/calendar'],
 ['finance.debtors','finance.debtors.write','/api/finance/debtors'],
 ['finance.cashflow','finance.cashflow.write','/api/finance/cashflow'],
 ['inventory.view','inventory.manage','/api/inventory/layouts/2/extended'],
 ['leads.view','leads.manage','/api/leads/2'],
 ['deals.view','deals.manage','/api/deals/2'],
 ['contracts.view','contracts.manage','/api/contracts'],
 ['tasks.view','tasks.manage','/api/tasks/2'],
 ['users.view','users.manage','/api/users/2'],
 ['settings.view','settings.manage','/api/dictionaries'],
 ['automation.view','automation.manage','/api/automation/settings'],
 ['analytics.view','analytics.view.write','/api/dashboard'],
 ['analytics.reports','analytics.reports.write','/api/reports']
];
describe('per-section read/write matrix',()=>{
 it.each(routes)('allows reading but blocks mutations for %s',async(read,write,path)=>{
  await expect(authorizeSectionRequest(req('GET',path,[read]))).resolves.toBeUndefined();
  for(const method of ['POST','PATCH','PUT','DELETE']) await expect(authorizeSectionRequest(req(method,path,[read]))).rejects.toMatchObject({statusCode:403});
 });
 it.each(routes)('requires both grants for writing to %s',async(read,write,path)=>{
  await expect(authorizeSectionRequest(req('PATCH',path,[read,write]))).resolves.toBeUndefined();
  await expect(authorizeSectionRequest(req('PATCH',path,[write]))).rejects.toMatchObject({statusCode:403});
 });
 it.each(routes)('denies reading without grant %s',async(read,write,path)=>{
  await expect(authorizeSectionRequest(req('GET',path,[]))).rejects.toMatchObject({statusCode:403});
 });
 it('isolates expenses from income and transfers',async()=>{
  for(const path of ['/api/finance/income','/api/finance/convert','/api/finance/transfers','/api/deals/2/payments']) await expect(authorizeSectionRequest(req('POST',path,['finance.expenses','finance.expenses.write']))).rejects.toMatchObject({statusCode:403});
 });
 it('prevents director and wildcard bypass',async()=>{
  const r=req('PATCH','/api/leads/2',['leads.view','*']);r.user.role='DIRECTOR';
  await expect(authorizeSectionRequest(r)).rejects.toMatchObject({statusCode:403});
 });
 it('preserves admin and legacy profiles',async()=>{
  for(const role of ['ADMIN','MANAGER']) await expect(authorizeSectionRequest({method:'POST',originalUrl:'/api/leads',user:{role,permissions:[]}})).resolves.toBeUndefined();
 });
 it('separates stock and settlements for existing and new documents',async()=>{
  getServiceDB.mockReturnValue({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{kind:'ACCRUAL'}})})})})});
  const grants=['construction.stock','construction.stock.write'];
  await expect(authorizeSectionRequest(req('POST','/api/construction/documents',grants,{kind:'ACCRUAL'}))).rejects.toMatchObject({statusCode:403});
  await expect(authorizeSectionRequest(req('PATCH','/api/construction/documents/11111111-1111-4111-8111-111111111111',grants))).rejects.toMatchObject({statusCode:403});
  await expect(authorizeSectionRequest(req('POST','/api/construction/documents',grants,{kind:'RECEIPT'}))).resolves.toBeUndefined();
 });
 it('blocks aggregated search without all section grants',async()=>{
  await expect(authorizeSectionRequest(req('GET','/api/search?q=test',['leads.view']))).rejects.toMatchObject({statusCode:403});
 });
});
