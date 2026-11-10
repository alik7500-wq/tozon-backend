import { metaRead } from './meta-assets.client.js';
export async function subscribeMetaLeadgen(pageId, token, request = fetch) {
  if (!/^[0-9]{1,30}$/.test(pageId) || !token) throw new Error('META_SUBSCRIPTION_INVALID');
  const appId = process.env.META_INSTAGRAM_APP_ID;
  if (!/^\d+$/.test(appId || '')) throw new Error('META_CONFIG_MISSING');
  const path = `/${pageId}/subscribed_apps`;
  const readFields = async () => {
    const body = await metaRead(path, token, { fields: 'id,subscribed_fields' }, request);
    if (!Array.isArray(body.data)) throw new Error('META_SUBSCRIPTION_INVALID');
    const own = body.data.find(app => String(app.id) === appId);
    if (!own && body.paging?.next) throw new Error('META_SUBSCRIPTION_INCOMPLETE');
    return Array.isArray(own?.subscribed_fields) ? own.subscribed_fields.filter(field => typeof field === 'string' && /^[a-z_]+$/.test(field)) : [];
  };
  const existing = await readFields();
  if (!existing.includes('leadgen')) {
    const response = await request(new URL('https://graph.facebook.com/v25.0' + path), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ subscribed_fields: [...new Set([...existing, 'leadgen'])].join(',') }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true) throw new Error('META_SUBSCRIPTION_FAILED');
  }
  if (!(await readFields()).includes('leadgen')) throw new Error('META_SUBSCRIPTION_NOT_CONFIRMED');
  return true;
}
