// Instagram API with Instagram Login (not Facebook Login).
// Keep the callback URL identical to the one configured in Meta.
const authorizeEndpoint = 'https://www.instagram.com/oauth/authorize';
const tokenEndpoint = 'https://api.instagram.com/oauth/access_token';
const longLivedEndpoint = 'https://graph.instagram.com/access_token';
const profileEndpoint = 'https://graph.instagram.com/me';

function configuration() {
  const appId = process.env.META_INSTAGRAM_APP_ID?.trim();
  const appSecret = process.env.META_INSTAGRAM_APP_SECRET?.trim();
  const redirectUri = process.env.META_INSTAGRAM_REDIRECT_URI?.trim();
  if (!appId || !appSecret || !redirectUri || !redirectUri.startsWith('https://')) {
    throw new Error('Instagram OAuth configuration is incomplete');
  }
  return { appId, appSecret, redirectUri };
}

export function instagramAuthorizationUrl(state) {
  const { appId, redirectUri } = configuration();
  const url = new URL(authorizeEndpoint);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'instagram_business_basic,instagram_business_manage_messages');
  url.searchParams.set('state', state);
  return url.toString();
}

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.error) {
    // Meta error bodies can contain sensitive data; do not log them.
    throw new Error('Instagram API request failed');
  }
  return result;
}

export async function exchangeInstagramAuthorizationCode(code) {
  if (typeof code !== 'string' || !code || code.length > 2048) throw new TypeError('Invalid authorization code');
  const { appId, appSecret, redirectUri } = configuration();
  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code
  });
  const result = await requestJson(tokenEndpoint, { method: 'POST', body });
  if (!result.access_token || !result.user_id) throw new Error('Incomplete Instagram token response');
  return { accessToken: result.access_token, instagramUserId: String(result.user_id) };
}

export async function exchangeInstagramLongLivedToken(shortLivedToken) {
  const { appSecret } = configuration();
  const url = new URL(longLivedEndpoint);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('access_token', shortLivedToken);
  const result = await requestJson(url);
  if (!result.access_token) throw new Error('Incomplete Instagram long-lived token response');
  return { accessToken: result.access_token, expiresIn: Number(result.expires_in) || null };
}

export async function fetchInstagramProfile(accessToken) {
  const url = new URL(profileEndpoint);
  url.searchParams.set('fields', 'user_id,username');
  url.searchParams.set('access_token', accessToken);
  const result = await requestJson(url);
  if (!result.user_id && !result.id) throw new Error('Incomplete Instagram profile');
  return { userId: String(result.user_id || result.id), username: result.username || null };
}
