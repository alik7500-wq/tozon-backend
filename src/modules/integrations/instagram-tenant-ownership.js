// Authoritative tenant membership checks. Never accept a tenant identifier from request input.
export async function verifyInstagramAssignmentTenant({ db, tenantId, accountId, managerId, actorId }) {
  if (!/^[a-z0-9_-]{2,64}$/.test(String(tenantId || '')) ||
      !/^[0-9]{5,30}$/.test(String(accountId || '')) ||
      !Number.isSafeInteger(managerId) || !Number.isSafeInteger(actorId)) return false;
  const checks = [
    ['avj_tenants', [['id', tenantId]]],
    ['avj_tenant_instagram_accounts', [['tenant_id', tenantId], ['instagram_account_id', accountId]]],
    ['avj_tenant_users', [['tenant_id', tenantId], ['user_id', managerId]]],
    ['avj_tenant_users', [['tenant_id', tenantId], ['user_id', actorId]]]
  ];
  for (const [table, filters] of checks) {
    let query = db.from(table).select('*');
    for (const [column, value] of filters) query = query.eq(column, value);
    const { data, error } = await query.limit(1);
    if (error || !Array.isArray(data) || data.length !== 1) return false;
  }
  return true;
}
