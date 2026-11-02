// Instagram Direct manager access is deny-by-default until assignment and tenant ownership
// are enforced on every conversation query and send operation.
export function canAccessInstagramConversation({ user, accountId, contactId, assignedUserId, tenantId, accountTenantId }) {
  if (!user || !/^[0-9]{5,30}$/.test(String(accountId || '')) ||
      !/^[0-9]{5,30}$/.test(String(contactId || ''))) return false;
  if (String(accountId) !== process.env.INSTAGRAM_INBOX_ACCOUNT_ID) return false;
  if (['ADMIN', 'DIRECTOR'].includes(user.role)) return true; // Current TOZON-only administration.
  if (process.env.INSTAGRAM_MANAGER_ACCESS_ENABLED !== 'true') return false;
  if (tenantId == null || accountTenantId == null || String(tenantId) !== String(accountTenantId)) return false;
  if (assignedUserId == null || user.id == null || String(assignedUserId) !== String(user.id)) return false;
  return true;
}
