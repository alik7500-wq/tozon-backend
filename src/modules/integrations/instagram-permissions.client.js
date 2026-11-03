// Read granted permissions from Meta's token inspection endpoint.
// Never infer messaging access from successful OAuth or requested scopes.
const GRAPH = 'https://graph.facebook.com/v25.0';
export async function inspectInstagramMessagingPermission({ userAccessToken, request = fetch }) {
  const appId = process.env.META_INSTAGRAM_APP_ID;
  const appSecret = process.env.META_INSTAGRAM_APP_SECRET;
  if (!/^\d+$/.test(appId || '') || !appSecret || !userAccessToken) {
    throw new Error('Meta token inspection unavailable');
  }
  const url = new URL(GRAPH + '/debug_token');
  url.searchParams.set('input_token', userAccessToken);
  const response = await request(url.toString(), {
    headers: { Authorization: 'Bearer ' + appId + '|' + appSecret },
    signal: AbortSignal.timeout(10000)
  });
  if (!response?.ok) throw new Error('Meta token inspection failed');
  const body = await response.json().catch(() => null);
  const data = body?.data;
  if (data?.is_valid !== true || String(data.app_id) !== String(appId)) {
    throw new Error('Meta token inspection did not validate application');
  }
  const granted = Array.isArray(data.scopes) ? data.scopes.filter(scope => typeof scope === 'string') : [];
  // The exact permission must be present in Meta's response, not just requested.
  return { grantedScopes: granted, messagingAllowed: granted.includes('instagram_manage_messages') };
}
