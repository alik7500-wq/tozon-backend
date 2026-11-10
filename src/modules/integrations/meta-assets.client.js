// The asset catalogue is read from Meta, never accepted from browser input.
const GRAPH = 'https://graph.facebook.com/v25.0';
export async function metaRead(path, token, params = {}, request = fetch) {
  if (!/^\/[a-zA-Z0-9_/]+$/.test(path) || !token) throw new Error('META_REQUEST_INVALID');
  const url = new URL(GRAPH + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await request(url, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error) throw new Error('META_ASSETS_UNAVAILABLE');
  return body;
}

async function readAll(path, token, params, request) {
  const rows = [];
  const cursors = new Set();
  let after;
  for (let page = 0; page < 30; page++) {
    const result = await metaRead(path, token, { ...params, limit: '100', ...(after ? { after } : {}) }, request);
    if (!Array.isArray(result.data)) throw new Error('META_ASSETS_INVALID');
    rows.push(...result.data);
    if (!result.paging?.next) return rows;
    // Never follow a remote URL containing credentials; reuse our fixed Graph origin.
    after = result.paging?.cursors?.after;
    if (typeof after !== 'string' || !after || cursors.has(after)) throw new Error('META_PAGING_INVALID');
    cursors.add(after);
  }
  throw new Error('META_ASSETS_LIMIT_EXCEEDED');
}

export async function discoverMetaAssets(accessToken, request = fetch) {
  const appId = process.env.META_INSTAGRAM_APP_ID;
  const appSecret = process.env.META_INSTAGRAM_APP_SECRET;
  if (!/^\d+$/.test(appId || '') || !appSecret) throw new Error('META_CONFIG_MISSING');
  const inspection = await metaRead('/debug_token', `${appId}|${appSecret}`, { input_token: accessToken }, request);
  const verified = inspection.data;
  if (verified?.is_valid !== true || String(verified.app_id) !== appId) throw new Error('META_TOKEN_INVALID');
  const now = Date.now() / 1000;
  const deadlines = [verified.expires_at, verified.data_access_expires_at].filter(n => Number(n) > 0).map(Number);
  if (deadlines.some(n => n <= now)) throw new Error('META_TOKEN_EXPIRED');
  const scopes = new Set(Array.isArray(verified.scopes) ? verified.scopes : []);
  const profile = await metaRead('/me', accessToken, { fields: 'id,name' }, request);
  if (!/^\d+$/.test(String(profile.id))) throw new Error('META_PROFILE_INVALID');
  const pages = await readAll('/me/accounts', accessToken, {
    fields: 'id,name,access_token,instagram_business_account{id,username}'
  }, request);
  const assets = [];
  for (const page of pages) {
    if (!/^\d+$/.test(String(page.id)) || !page.access_token) continue;
    const add = (channel, externalId, name, username = null) => assets.push({
      channel, external_id: String(externalId), page_id: String(page.id),
      name: String(name || externalId).slice(0, 300), username,
      access_token: page.access_token
    });
    if (scopes.has('pages_messaging')) add('FACEBOOK_MESSAGES', page.id, page.name);
    if (scopes.has('pages_read_engagement') && scopes.has('pages_manage_engagement')) add('FACEBOOK_COMMENTS', page.id, page.name);
    const ig = page.instagram_business_account;
    if (/^\d+$/.test(String(ig?.id)) && scopes.has('instagram_basic')) {
      if (scopes.has('instagram_manage_messages')) add('INSTAGRAM_MESSAGES', ig.id, ig.username || page.name, ig.username || null);
      if (scopes.has('instagram_manage_comments')) add('INSTAGRAM_COMMENTS', ig.id, ig.username || page.name, ig.username || null);
    }
    if (scopes.has('leads_retrieval') && scopes.has('pages_manage_ads')) {
      const forms = await readAll(`/${page.id}/leadgen_forms`, page.access_token, { fields: 'id,name,status' }, request);
      for (const form of forms) {
        if (/^\d+$/.test(String(form.id)) && form.status === 'ACTIVE') add('FACEBOOK_FORM', form.id, `${page.name} / ${form.name}`);
      }
    }
  }
  return {
    profile: { id: String(profile.id), name: String(profile.name || '').slice(0, 300) },
    expiresAt: deadlines.length ? new Date(Math.min(...deadlines) * 1000).toISOString() : null,
    scopes: [...scopes], assets
  };
}
