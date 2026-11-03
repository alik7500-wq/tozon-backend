// Meta Facebook Login for Business authorization; no token exchange here.
// Configured Meta app ID and redirect must match the Meta dashboard.
export function facebookBusinessInstagramAuthorizationUrl(state) {
  const appId = process.env.META_INSTAGRAM_APP_ID;
  const redirect = process.env.META_INSTAGRAM_REDIRECT_URI;
  if (!/^\d+$/.test(appId || '') || !redirect?.startsWith('https://')) {
    throw new Error('Meta Business Login configuration missing');
  }
  if (typeof state !== 'string' || state.length < 24) throw new TypeError('Invalid OAuth state');
  const url = new URL('https://www.facebook.com/dialog/oauth');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('config_id', '29138384382458786');
  url.searchParams.set('state', state);
  return url.toString();
}
