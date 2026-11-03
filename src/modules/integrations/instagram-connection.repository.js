import { getServiceDB } from '../../db/connection.js';
import { encryptSocialToken } from './social-token-crypto.js';

export async function saveTozonInstagramConnection({ instagramUserId, username, accessToken, expiresIn, grantedScopes = [] }) {
  if (!instagramUserId || !accessToken) throw new TypeError('Instagram account and token are required');
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  const encryptedToken = encryptSocialToken(accessToken);
  const db = getServiceDB();
  // TOZON-only single account: never silently replace another connected account.
  const { data: existing, error: readError } = await db.from('tozon_instagram_connections')
    .select('id,instagram_user_id').eq('status', 'connected').limit(1);
  if (readError) throw new Error('Instagram connection lookup failed');
  if (existing?.length && existing[0].instagram_user_id !== String(instagramUserId)) {
    throw new Error('Another Instagram account is already connected');
  }
  const { error } = await db.from('tozon_instagram_connections').upsert({
    instagram_user_id: String(instagramUserId),
    username: username || null,
    encrypted_access_token: encryptedToken,
    token_expires_at: expiresAt,
    granted_scopes: Array.isArray(grantedScopes) ? grantedScopes.filter(scope => typeof scope === 'string') : [], // Verified by Meta token inspection.
    status: 'connected',
    updated_at: new Date().toISOString()
  }, { onConflict: 'instagram_user_id' });
  if (error) throw new Error('Instagram connection could not be saved');
  return { instagramUserId: String(instagramUserId), username: username || null, expiresAt };
}

export async function getTozonInstagramConnectionStatus() {
  const { data, error } = await getServiceDB().from('tozon_instagram_connections')
    .select('instagram_user_id,username,status,token_expires_at')
    .eq('status', 'connected').limit(1);
  if (error) throw new Error('Instagram connection status lookup failed');
  const record = data?.[0];
  if (!record) return { connected: false, available: true };
  const expired = Boolean(record.token_expires_at && new Date(record.token_expires_at).getTime() <= Date.now());
  return {
    connected: !expired,
    available: true,
    username: record.username,
    expiresAt: record.token_expires_at,
    needsReconnect: expired
  };
}
