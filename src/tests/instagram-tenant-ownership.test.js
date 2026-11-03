import { describe, expect, it, vi } from 'vitest';
import { verifyInstagramAssignmentTenant } from '../modules/integrations/instagram-tenant-ownership.js';

const valid = { tenantId: 'tozon', accountId: '17841447499018452', managerId: 2, actorId: 1 };

function fakeDb(rows = {}, errors = {}) {
  const from = vi.fn(table => {
    const filters = [];
    const query = {
      select: () => query,
      eq: (column, value) => { filters.push([column, value]); return query; },
      limit: async () => ({
        data: errors[table] ? null : (rows[table] || []).filter(row => filters.every(([k, v]) => row[k] === v)).slice(0, 1),
        error: errors[table] || null
      })
    };
    return query;
  });
  return { from };
}

function membership() {
  return {
    avj_tenants: [{ id: 'tozon' }],
    avj_tenant_instagram_accounts: [{ tenant_id: 'tozon', instagram_account_id: valid.accountId }],
    avj_tenant_users: [
      { tenant_id: 'tozon', user_id: 1 },
      { tenant_id: 'tozon', user_id: 2 }
    ]
  };
}

describe('Instagram assignment tenant ownership', () => {
  it('allows only verified company, account, manager and actor', async () => {
    expect(await verifyInstagramAssignmentTenant({ db: fakeDb(membership()), ...valid })).toBe(true);
  });
  it('denies manager from another tenant', async () => {
    const rows = membership();
    rows.avj_tenant_users[1].tenant_id = 'other';
    expect(await verifyInstagramAssignmentTenant({ db: fakeDb(rows), ...valid })).toBe(false);
  });
  it('denies actor from another tenant', async () => {
    const rows = membership();
    rows.avj_tenant_users[0].tenant_id = 'other';
    expect(await verifyInstagramAssignmentTenant({ db: fakeDb(rows), ...valid })).toBe(false);
  });
  it('denies account from another tenant', async () => {
    const rows = membership();
    rows.avj_tenant_instagram_accounts[0].tenant_id = 'other';
    expect(await verifyInstagramAssignmentTenant({ db: fakeDb(rows), ...valid })).toBe(false);
  });
  it('denies missing company', async () => {
    const rows = membership();
    rows.avj_tenants = [];
    expect(await verifyInstagramAssignmentTenant({ db: fakeDb(rows), ...valid })).toBe(false);
  });
  it('fails closed on database errors', async () => {
    expect(await verifyInstagramAssignmentTenant({ db: fakeDb(membership(), { avj_tenant_users: { message: 'offline' } }), ...valid })).toBe(false);
  });
  it('rejects malformed identifiers before database access', async () => {
    const db = fakeDb(membership());
    expect(await verifyInstagramAssignmentTenant({ db, ...valid, managerId: '2' })).toBe(false);
    expect(await verifyInstagramAssignmentTenant({ db, ...valid, tenantId: '../other' })).toBe(false);
    expect(db.from).not.toHaveBeenCalled();
  });
});
