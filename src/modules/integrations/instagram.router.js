import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { createOAuthState } from './social-oauth-state.js';
import { saveInstagramOAuthState, consumeInstagramOAuthState } from './instagram-oauth.repository.js';
import { facebookBusinessInstagramAuthorizationUrl } from './facebook-business-instagram-oauth.js';
import { exchangeFacebookBusinessCode, extendFacebookBusinessToken, resolveTozonInstagramAccount } from './facebook-business-token.client.js';
import { inspectInstagramMessagingPermission } from './instagram-permissions.client.js';
import { saveTozonInstagramConnection, getTozonInstagramConnectionStatus } from './instagram-connection.repository.js';

const router = Router();
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
  const { code, state } = req.query;
  if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
    return res.status(400).send('Instagram authorization was not completed');
  }
  try {
    const initiated = await consumeInstagramOAuthState({ state });
    if (!initiated) return res.status(403).send('Instagram authorization expired or already used');
    const shortLived = await exchangeFacebookBusinessCode(code);
    const longLived = await extendFacebookBusinessToken(shortLived.accessToken);
    const account = await resolveTozonInstagramAccount(longLived.accessToken);
    // Inspect the exact Page token used by the send endpoint, not a different user token.
    const permissions = await inspectInstagramMessagingPermission({ userAccessToken: account.pageAccessToken });
    await saveTozonInstagramConnection({
      instagramUserId: account.instagramUserId,
      username: 'tozon_plaza',
      accessToken: account.pageAccessToken,
      expiresIn: null,
      grantedScopes: permissions.grantedScopes
    });
    return res.status(200).type('text/plain').send('Instagram @tozon_plaza connected. Return to TOZON CRM.');
  } catch {
    return res.status(503).send('Instagram authorization failed. Please retry from TOZON CRM.');
  }
});

export default router;
