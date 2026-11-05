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
    // An error mentioning app_secret is NOT proof the secret is wrong.
    // Classify only explicit invalid-secret messages; keep other cases distinct.
    const diagnostic = /redirect.uri|redirect_uri|redirect uri/.test(explanation) ? 'REDIRECT_URI_MISMATCH'
      : /(?:invalid|incorrect|wrong|mismatch|does not match|not valid|could not be verified|cannot be verified|failed to verify)[^.!\\n]{0,90}(?:app.secret|app_secret|client.secret|client_secret)|(?:app.secret|app_secret|client.secret|client_secret)[^.!\\n]{0,90}(?:invalid|incorrect|wrong|mismatch|does not match|not valid|could not be verified|cannot be verified|failed to verify)/.test(explanation) ? 'APP_SECRET_REJECTED'
      : /(?:app.secret|app_secret|client.secret|client_secret)/.test(explanation) ? 'APP_SECRET_PARAMETER_RELATED'
      : /invalid.*(verification code|authorization code|code)|code.*(expired|used|invalid)/.test(explanation) ? 'AUTHORIZATION_CODE_INVALID'
      : /unsupported.*(method|request)|method.*not.*supported/.test(explanation) ? 'HTTP_METHOD_UNSUPPORTED'
      : /permission|scope|access/.test(explanation) ? 'PERMISSION_OR_ACCESS'
      : /temporar|try again|unavailable/.test(explanation) ? 'META_TEMPORARY_FAILURE'
      : 'UNCLASSIFIED';
    // Meta code 1 often contains a parameter-specific explanation. Emit only
    // fixed categories, never Meta's raw error text or credential values.
    const secretContext = /app.secret|app_secret|client.secret|client_secret/.test(explanation);
    const secretIssue = /(?:error|failed|failure|unable|could not|cannot) (?:in |of )?(?:validating|verifying|authenticate|authenticating|validate|verify)[^.!\\n]{0,100}(?:app.secret|app_secret|client.secret|client_secret)|(?:app.secret|app_secret|client.secret|client_secret)[^.!\\n]{0,100}(?:could not be validated|cannot be validated|verification failed)/.test(explanation) ? 'META_CANNOT_VALIDATE_CLIENT_SECRET'
      : !secretContext ? 'NOT_MENTIONED'
      : /(?:must be|is) (?:a |an )?(?:string|valid string)|parameter.*(?:missing|required)|missing.*parameter|parameter.*required/.test(explanation) ? 'MISSING_OR_INVALID_PARAMETER'
      : /(?:app.secret|app_secret|client.secret|client_secret).{0,90}(?:must|should|needs to|required)/.test(explanation) ? 'PARAMETER_REQUIREMENT'
      : /(?:app.secret|app_secret|client.secret|client_secret).{0,90}(?:match|same as|equal|identical|client token)/.test(explanation) ? 'SECRET_RELATIONSHIP'
      : /(?:app.secret|app_secret|client.secret|client_secret).{0,90}(?:invalid|wrong|incorrect|rejected)/.test(explanation) ? 'SECRET_REJECTED'
      : 'OTHER_SECRET_REFERENCE';
    // Fixed booleans expose Meta's error *category*, not its free-form message.
    // Useful when Meta uses unexpected wording (e.g. "appsecret_proof" or
    // "client_secret" in a generic error). Never log the explanation itself.
    const metaHints = {
      appSecret: /app[_ ]?secret|client[_ ]?secret/i.test(explanation),
      appsecretProof: /appsecret[_ ]?proof/i.test(explanation),
      appId: /app[_ ]?id|client[_ ]?id/i.test(explanation),
      redirectUri: /redirect[_ ]?uri|redirect uri/i.test(explanation),
      code: /(?:verification|authorization|auth) code/i.test(explanation),
      missing: /missing|not provided|not supplied|required/i.test(explanation),
      invalid: /invalid|not valid|incorrect|wrong/i.test(explanation),
      verification: /verif|validat|authenticat/i.test(explanation),
      permission: /permission|scope/i.test(explanation),
      unsupported: /unsupported|not supported/i.test(explanation),
      expired: /expired|already used/i.test(explanation),
      token: /(?:access|client|user) token/i.test(explanation),
      parameter: /parameter|param/i.test(explanation)
    };
    // This classification is intentionally independent of raw Meta text.
    // A failed client-secret verification is a credential/configuration problem,
    // not evidence that the selected Instagram account is wrong.
    console.error('[instagram-meta] Graph API failed', { endpoint: path, httpStatus: response.status, metaCode, metaSubcode, metaType, transient, diagnostic, secretIssue, metaHints });
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
  const pages = Array.isArray(result.data) ? result.data : [];
  const matches = pages.filter(p => String(p.instagram_business_account?.id) === '17841447499018452');
  if (matches.length !== 1 || !matches[0].access_token) {
    // No Page IDs, names or tokens in logs. Distinguish a missing Page grant
    // from a missing IG link so the operator can fix the correct Meta asset.
    const diagnostic = pages.length === 0 ? 'NO_FACEBOOK_PAGES_GRANTED'
      : matches.length === 0 ? 'TARGET_INSTAGRAM_NOT_LINKED_TO_GRANTED_PAGE'
      : matches.length > 1 ? 'DUPLICATE_TARGET_INSTAGRAM_LINK'
      : 'PAGE_ACCESS_TOKEN_MISSING';
    console.error('[instagram-meta] Instagram account resolution failed', {
      diagnostic, grantedPageCount: pages.length,
      linkedInstagramCount: pages.filter(p => p.instagram_business_account?.id).length
    });
    throw new Error('Expected TOZON Instagram page is unavailable');
  }
  return { instagramUserId: '17841447499018452', pageId: String(matches[0].id), pageAccessToken: matches[0].access_token };
}
