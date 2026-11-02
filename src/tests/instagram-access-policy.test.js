import { describe, expect, it, beforeEach } from 'vitest';
import { canAccessInstagramConversation as can } from '../modules/integrations/instagram-access.policy.js';
const accountId = '17841447499018452';
const contactId = '123456789';
describe('Instagram manager access policy', () => {
  beforeEach(() => {
    process.env.INSTAGRAM_INBOX_ACCOUNT_ID = accountId;
    delete process.env.INSTAGRAM_MANAGER_ACCESS_ENABLED;
  });
  it('allows TOZON administrators on the configured account', () => {
    expect(can({ user: { id: 1, role: 'ADMIN' }, accountId, contactId })).toBe(true);
  });
  it('denies manager access by default', () => {
    expect(can({ user: { id: 3, role: 'MANAGER' }, accountId, contactId, assignedUserId: 3, tenantId: 7, accountTenantId: 7 })).toBe(false);
  });
  it('requires tenant and conversation assignment after opt-in', () => {
    process.env.INSTAGRAM_MANAGER_ACCESS_ENABLED = 'true';
    const base = { user: { id: 3, role: 'MANAGER' }, accountId, contactId, tenantId: 7, accountTenantId: 7, assignedUserId: 3 };
    expect(can(base)).toBe(true);
    expect(can({ ...base, accountTenantId: 8 })).toBe(false);
    expect(can({ ...base, assignedUserId: 4 })).toBe(false);
    expect(can({ ...base, assignedUserId: undefined })).toBe(false);
  });
  it('denies other Instagram accounts and malformed contacts', () => {
    expect(can({ user: { role: 'ADMIN' }, accountId: '17841447499018453', contactId })).toBe(false);
    expect(can({ user: { role: 'ADMIN' }, accountId, contactId: 'bad' })).toBe(false);
  });
});
