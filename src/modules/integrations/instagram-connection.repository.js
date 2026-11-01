import { getServiceDB } from '../../db/connection.js';
import { encryptSocialToken } from './social-token-crypto.js';

export async function saveTozonInstagramConnection({ instagramUserId, username, accessToken, expiresIn }) {
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
    granted_scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    status: 'connected',
    updated_at: new Date().toISOString()
  }, { onConflict: 'instagram_user_id' });
  if (error) throw new Error('Instagram connection could not be saved');
  return { instagramUserId: String(instagramUserId), username: username || null, expiresAt };
}
