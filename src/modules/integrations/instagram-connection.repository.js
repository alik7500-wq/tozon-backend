import { getServiceDB } from '../../db/connection.js';
import { encryptSocialToken, decryptSocialToken } from './social-token-crypto.js';

export const validInstagramAccountId = id => typeof id === 'string' && /^\d{5,40}$/.test(id);
const usable = row => row && (!row.token_expires_at || Date.parse(row.token_expires_at) > Date.now()) && row.granted_scopes?.includes('instagram_manage_messages');
const credential = row => ({ accountId: String(row.instagram_user_id), token: decryptSocialToken(row.encrypted_access_token) });
export async function isInstagramOAuthActorActive(userId) {
  const {data,error}=await getServiceDB().from('users').select('id,role,is_active').eq('id',userId).maybeSingle();
  if(error)throw new Error('Instagram actor lookup failed');
  return Boolean(data?.is_active && ['ADMIN','DIRECTOR'].includes(data.role));
}

// Installation-local credentials: callers must never serialize this object.
export async function getInstagramInboxCredentials(accountId) {
  if (accountId !== undefined && !validInstagramAccountId(accountId)) return null;
  let query = getServiceDB().from('tozon_instagram_connections')
    .select('instagram_user_id,encrypted_access_token,token_expires_at,granted_scopes').eq('status', 'connected');
  if (accountId !== undefined) query = query.eq('instagram_user_id', accountId);
  const { data, error } = await query.limit(2);
  if (error) throw new Error('Connection lookup unavailable');
  // Legacy unscoped routes are safe only when exactly one account is connected.
  const row = data?.length === 1 ? data[0] : null;
  return usable(row) ? credential(row) : null;
}
export async function getAllInstagramInboxCredentials() {
  const { data, error } = await getServiceDB().from('tozon_instagram_connections')
    .select('instagram_user_id,encrypted_access_token,token_expires_at,granted_scopes').eq('status', 'connected').limit(100);
  if (error) throw new Error('Connection lookup unavailable');
  return (data || []).filter(usable).flatMap(row => { try { return [credential(row)]; } catch { console.warn('[instagram-credentials] ACCOUNT_TOKEN_UNAVAILABLE'); return []; } });
}
export async function connectedInstagramAccountIds() {
  const { data, error } = await getServiceDB().from('tozon_instagram_connections').select('instagram_user_id').eq('status', 'connected').limit(100);
  if (error) throw new Error('Connection lookup unavailable');
  return new Set((data || []).map(row => String(row.instagram_user_id)));
}
export async function saveInstagramConnections(accounts) {
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 100) throw new TypeError('Instagram accounts required');
  const ids = new Set();
  const rows = accounts.map(({instagramUserId,username,accessToken,expiresIn,grantedScopes=[]}) => {
    if (!validInstagramAccountId(instagramUserId) || !accessToken || ids.has(instagramUserId) || !grantedScopes.includes('instagram_manage_messages')) throw new TypeError('Invalid Instagram connection');
    ids.add(instagramUserId);
    return { instagram_user_id: instagramUserId, username: username || null,
      encrypted_access_token: encryptSocialToken(accessToken),
      token_expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now()+expiresIn*1000).toISOString() : null,
      granted_scopes: grantedScopes.filter(scope => typeof scope === 'string'), status:'connected', updated_at:new Date().toISOString() };
  });
  // One atomic upsert. Unselected existing accounts are left intact.
  const { error } = await getServiceDB().from('tozon_instagram_connections').upsert(rows,{onConflict:'instagram_user_id'});
  if (error) throw new Error('Instagram connections could not be saved');
  // Establish the lead cutoff before subscribing: the very first incoming event
  // must count as new, even if it arrives before the background sync starts.
  const { error: rolloutError } = await getServiceDB().from('crm_instagram_rollout')
    .upsert(rows.map(row => ({account_id:row.instagram_user_id})), {onConflict:'account_id',ignoreDuplicates:true});
  if (rolloutError) throw new Error('Instagram lead activation failed');
  return rows.map(row=>({accountId:row.instagram_user_id,username:row.username}));
}
export async function saveTozonInstagramConnection(account) { return saveInstagramConnections([account]); }
export async function disconnectInstagramAccount(accountId) {
  if (!validInstagramAccountId(accountId)) throw new TypeError('Invalid Instagram account');
  const { data,error } = await getServiceDB().from('tozon_instagram_connections').update({status:'revoked',
    encrypted_access_token:encryptSocialToken('disconnected'),granted_scopes:[],updated_at:new Date().toISOString()})
    .eq('instagram_user_id',accountId).eq('status','connected').select('instagram_user_id');
  if (error) throw new Error('Instagram disconnect failed');
  return Boolean(data?.length);
}
export async function getTozonInstagramConnectionStatus() {
  const {data,error}=await getServiceDB().from('tozon_instagram_connections')
    .select('instagram_user_id,username,status,token_expires_at,granted_scopes').eq('status','connected').order('created_at').limit(100);
  if(error)throw new Error('Instagram connection status lookup failed');
  const accounts=(data||[]).map(row=>({accountId:String(row.instagram_user_id),username:row.username,
    connected:usable(row),expiresAt:row.token_expires_at,needsReconnect:!usable(row)}));
  const single=accounts.length===1?accounts[0]:null;
  return {connected:accounts.some(a=>a.connected),available:true,accounts,
    ...(single?{username:single.username,expiresAt:single.expiresAt,needsReconnect:single.needsReconnect}: {})};
}
