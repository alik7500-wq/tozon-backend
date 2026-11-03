import { getServiceDB } from '../../db/connection.js';
import { digestOAuthState, oauthStateExpiry } from './social-oauth-state.js';

const table = 'tozon_instagram_oauth_states';

export async function saveInstagramOAuthState({ state, userId }) {
  if (userId === undefined || userId === null) throw new TypeError('User ID required');
  const { error } = await getServiceDB().from(table).insert({
    state_digest: digestOAuthState(state),
    initiated_by: String(userId),
    expires_at: oauthStateExpiry()
  });
  if (error) throw new Error('Failed to store Instagram authorization state');
}

export async function consumeInstagramOAuthState({ state }) {
  const digest = digestOAuthState(state);
  const now = new Date().toISOString();
  const { data, error } = await getServiceDB().from(table)
    .update({ consumed_at: now })
    .eq('state_digest', digest)
    .is('consumed_at', null)
    .gt('expires_at', now)
    .select('initiated_by')
    .maybeSingle();
  if (error) throw new Error('Failed to verify Instagram authorization state');
  if (!data) return null;
  return { userId: data.initiated_by };
}
