import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { createOAuthState } from './social-oauth-state.js';
import { saveInstagramOAuthState, consumeInstagramOAuthState } from './instagram-oauth.repository.js';
import { facebookBusinessInstagramAuthorizationUrl } from './facebook-business-instagram-oauth.js';
import { exchangeFacebookBusinessCode, extendFacebookBusinessToken, resolveTozonInstagramAccount } from './facebook-business-token.client.js';
import { inspectInstagramMessagingPermission } from './instagram-permissions.client.js';
import { saveTozonInstagramConnection, getTozonInstagramConnectionStatus } from './instagram-connection.repository.js';

const router = Router();
const oauthEnabled = () => process.env.INSTAGRAM_OAUTH_ENABLED === 'true';
const onlyAdministrator = (req, res, next) => {
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return res.sendStatus(403);
  next();
};

router.get('/connection', protect, onlyAdministrator, async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const connection = await getTozonInstagramConnectionStatus();
    return res.json({ status: 'success', data: { provider: 'instagram', ...connection } });
  } catch {
    return res.status(503).json({ status: 'error', code: 'INSTAGRAM_CONNECTION_STATUS_UNAVAILABLE' });
  }
});

router.post('/connect', protect, onlyAdministrator, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!oauthEnabled()) return res.status(503).json({ status: 'error', code: 'INSTAGRAM_OAUTH_DISABLED' });
  try {
    const { state } = createOAuthState();
    const authorizationUrl = facebookBusinessInstagramAuthorizationUrl(state);
    await saveInstagramOAuthState({ state, userId: req.user.id });
    return res.json({ status: 'success', data: { authorizationUrl } });
  } catch {
    return res.status(503).json({ status: 'error', code: 'INSTAGRAM_OAUTH_UNAVAILABLE' });
  }
});

router.get('/callback', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!oauthEnabled()) return res.status(503).type('text/plain').send('Instagram connection is not enabled');
  const { code, state } = req.query;
  if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
    return res.status(400).send('Instagram authorization was not completed');
  }
  let stage = 'consume_state';
  try {
    const initiated = await consumeInstagramOAuthState({ state });
    if (!initiated) return res.status(403).send('Instagram authorization expired or already used');
    stage = 'exchange_code';
    const shortLived = await exchangeFacebookBusinessCode(code);
    stage = 'extend_token';
    const longLived = await extendFacebookBusinessToken(shortLived.accessToken);
    stage = 'resolve_instagram_account';
    const account = await resolveTozonInstagramAccount(longLived.accessToken);
    // Inspect the exact Page token used by the send endpoint, not a different user token.
    stage = 'check_messaging_permission';
    const permissions = await inspectInstagramMessagingPermission({ userAccessToken: account.pageAccessToken });
    // Never mark Direct as connected when Meta has not granted messaging access.
    if (!permissions.messagingAllowed) return res.status(403).type('text/plain').send('Instagram messaging permission has not been granted in Meta.');
    stage = 'save_connection';
    await saveTozonInstagramConnection({
      instagramUserId: account.instagramUserId,
      username: 'tozon_plaza',
      accessToken: account.pageAccessToken,
      expiresIn: null,
      grantedScopes: permissions.grantedScopes
    });
    return res.status(200).type('text/plain').send('Instagram @tozon_plaza connected. Return to TOZON CRM.');
  } catch {
    // Log only a fixed stage name: never log OAuth codes, tokens, state or Meta error payloads.
    console.error('[instagram-oauth] callback failed at stage:', stage);
    return res.status(503).send('Instagram authorization failed. Please retry from TOZON CRM.');
  }
});

export default router;
