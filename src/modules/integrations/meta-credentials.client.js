// Read-only app credential check. The app token is deliberately never returned.
export async function checkMetaCredentials(request = fetch) {
  const id = process.env.META_INSTAGRAM_APP_ID;
  const secret = process.env.META_INSTAGRAM_APP_SECRET;
  if (!/^\d+$/.test(id || '') || !secret) return { accepted: false, diagnostic: 'CONFIGURATION_MISSING', httpStatus: null, metaCode: null };
  try {
    const url = new URL('https://graph.facebook.com/v25.0/oauth/access_token');
    for (const [key, value] of Object.entries({ client_id: id, client_secret: secret, grant_type: 'client_credentials' })) url.searchParams.set(key, value);
    const response = await request(url, { signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    const accepted = Boolean(response.ok && !body.error && typeof body.access_token === 'string' && body.access_token);
    const secretRejected = /error validating client secret/i.test(String(body.error?.message || ''));
    return { accepted, diagnostic: accepted ? 'APP_CREDENTIALS_ACCEPTED' : secretRejected ? 'META_CANNOT_VALIDATE_CLIENT_SECRET' : 'META_APP_CHECK_FAILED',
      httpStatus: response.status, metaCode: Number.isInteger(body.error?.code) ? body.error.code : null };
  } catch { return { accepted: false, diagnostic: 'NETWORK_OR_UNREADABLE_RESPONSE', httpStatus: null, metaCode: null }; }
}
