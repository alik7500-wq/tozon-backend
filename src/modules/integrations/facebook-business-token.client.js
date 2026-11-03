// Facebook Login for Business uses graph.facebook.com, not Instagram Login token endpoints.
const graph = 'https://graph.facebook.com/v25.0';
function config() {
  const id = process.env.META_INSTAGRAM_APP_ID;
  const secret = process.env.META_INSTAGRAM_APP_SECRET;
  const redirect = process.env.META_INSTAGRAM_REDIRECT_URI;
  if (!/^\d+$/.test(id || '') || !secret || !redirect?.startsWith('https://')) throw new Error('Meta OAuth configuration missing');
  return { id, secret, redirect };
}
async function graphGet(path, params) {
  const url = new URL(graph + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // Meta's Facebook Login OAuth token endpoint is documented as a GET request.
  // Never log the URL, query parameters, response payload or credentials.
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error) {
    // Only diagnostic numeric fields: never expose tokens, authorization codes, request URLs or Meta messages.
    const metaCode = Number.isInteger(body?.error?.code) ? body.error.code : null;
    const metaSubcode = Number.isInteger(body?.error?.error_subcode) ? body.error.error_subcode : null;
    const allowedTypes = new Set(['OAuthException', 'GraphMethodException', 'FacebookApiException', 'Exception']);
    const metaType = allowedTypes.has(body?.error?.type) ? body.error.type : 'unknown';
    const transient = body?.error?.is_transient === true;
    // Classify Meta's explanation without logging its raw message, codes, tokens or URLs.
    const explanation = String(body?.error?.message || '').toLowerCase();
    const diagnostic = /redirect.uri|redirect_uri|redirect uri/.test(explanation) ? 'REDIRECT_URI_MISMATCH'
      : /app.secret|app_secret|client.secret|client_secret/.test(explanation) ? 'APP_SECRET_INVALID'
      : /invalid.*(verification code|authorization code|code)|code.*(expired|used|invalid)/.test(explanation) ? 'AUTHORIZATION_CODE_INVALID'
      : /unsupported.*(method|request)|method.*not.*supported/.test(explanation) ? 'HTTP_METHOD_UNSUPPORTED'
      : /permission|scope|access/.test(explanation) ? 'PERMISSION_OR_ACCESS'
      : /temporar|try again|unavailable/.test(explanation) ? 'META_TEMPORARY_FAILURE'
      : 'UNCLASSIFIED';
    console.error('[instagram-meta] Graph API failed', { endpoint: path, httpStatus: response.status, metaCode, metaSubcode, metaType, transient, diagnostic });
    throw new Error('Meta Graph API request failed');
  }
  return body;
}
export async function exchangeFacebookBusinessCode(code) {
  if (typeof code !== 'string' || !code || code.length > 2048) throw new TypeError('Invalid code');
  const { id, secret, redirect } = config();
  const token = await graphGet('/oauth/access_token', { client_id: id, client_secret: secret, redirect_uri: redirect, code });
  if (typeof token.access_token !== 'string') throw new Error('Missing Meta token');
  return { accessToken: token.access_token, expiresIn: Number(token.expires_in) || null };
}
export async function extendFacebookBusinessToken(accessToken) {
  const { id, secret } = config();
  const token = await graphGet('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: id, client_secret: secret, fb_exchange_token: accessToken });
  if (typeof token.access_token !== 'string') throw new Error('Missing Meta long-lived token');
  return { accessToken: token.access_token, expiresIn: Number(token.expires_in) || null };
}
export async function resolveTozonInstagramAccount(accessToken) {
  const result = await graphGet('/me/accounts', { fields: 'id,name,access_token,instagram_business_account', access_token: accessToken, limit: '100' });
  const matches = (result.data || []).filter(p => String(p.instagram_business_account?.id) === '17841447499018452');
  if (matches.length !== 1 || !matches[0].access_token) throw new Error('Expected TOZON Instagram page is unavailable');
  return { instagramUserId: '17841447499018452', pageId: String(matches[0].id), pageAccessToken: matches[0].access_token };
}
