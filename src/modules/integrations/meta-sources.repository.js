import { getServiceDB } from '../../db/connection.js';
import { encryptSocialToken } from './social-token-crypto.js';
import { digestOAuthState, oauthStateExpiry } from './social-oauth-state.js';

const publicConnection = 'id,meta_user_id,display_name,status,token_expires_at';
const publicSource = 'id,channel,external_id,page_id,name,username,project_id,available,projects(name)';
const check = result => { if (result.error) throw new Error('META_STORAGE_UNAVAILABLE'); return result.data; };
export const MetaSources = {
  async saveState(state, ownerId) {
    check(await getServiceDB().from('meta_source_oauth_states').insert({
      state_digest: digestOAuthState(state), owner_user_id: String(ownerId), expires_at: oauthStateExpiry()
    }));
  },
  async consumeState(state) {
    const now = new Date().toISOString();
    return check(await getServiceDB().from('meta_source_oauth_states').update({ consumed_at: now })
      .eq('state_digest', digestOAuthState(state)).is('consumed_at', null).is('cancelled_at', null).gt('expires_at', now)
      .select('owner_user_id').maybeSingle());
  },
  async sync(ownerId, token, catalogue, state) {
    const assets = catalogue.assets.map(({ access_token, ...asset }) => ({
      ...asset, encrypted_access_token: encryptSocialToken(access_token)
    }));
    check(await getServiceDB().rpc('sync_meta_source_catalogue', {
      p_owner: String(ownerId), p_meta_user: catalogue.profile.id, p_name: catalogue.profile.name,
      p_token: encryptSocialToken(token), p_expires: catalogue.expiresAt, p_assets: assets,
      p_state_digest: digestOAuthState(state)
    }));
  },
  async list(ownerId) {
    const db = getServiceDB();
    const projects = check(await db.from('projects').select('id,name').is('archived_at', null).order('name')) || [];
    const connection = check(await db.from('meta_source_connections').select(publicConnection)
      .eq('owner_user_id', String(ownerId)).maybeSingle());
    if (!connection) return { connection: null, sources: [], projects };
    const expired = Boolean(connection.token_expires_at && new Date(connection.token_expires_at).getTime() <= Date.now());
    const sources = check(await db.from('meta_project_sources').select(publicSource)
      .eq('connection_id', connection.id).order('name')) || [];
    return { connection: { ...connection, connected: connection.status === 'connected' && !expired, needsReconnect: expired }, sources, projects };
  },
  async bind(ownerId, sourceId, projectId) {
    // Single transaction checks ownership and project availability, including disconnect races.
    return check(await getServiceDB().rpc('bind_meta_project_source', {
      p_owner: String(ownerId), p_source: sourceId, p_project: projectId
    }));
  },
  async disconnect(ownerId) {
    // Tokens and bindings are cleared atomically; historical events remain in their original project.
    check(await getServiceDB().rpc('disconnect_meta_source_connection', { p_owner: String(ownerId) }));
  }
};
