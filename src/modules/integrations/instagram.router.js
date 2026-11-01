import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { createOAuthState } from './social-oauth-state.js';
import { saveInstagramOAuthState, consumeInstagramOAuthState } from './instagram-oauth.repository.js';
import { instagramAuthorizationUrl, exchangeInstagramAuthorizationCode, exchangeInstagramLongLivedToken, fetchInstagramProfile } from './instagram-meta.client.js';
import { saveTozonInstagramConnection } from './instagram-connection.repository.js';

const router = Router();
const onlyAdministrator = (req, res, next) => {
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return res.sendStatus(403);
  next();
};

router.get('/connection', protect, onlyAdministrator, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { provider: 'instagram', connected: false, available: false } });
});

router.post('/connect', protect, onlyAdministrator, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { state } = createOAuthState();
    const authorizationUrl = instagramAuthorizationUrl(state);
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
    const shortLived = await exchangeInstagramAuthorizationCode(code);
    const longLived = await exchangeInstagramLongLivedToken(shortLived.accessToken);
    const profile = await fetchInstagramProfile(longLived.accessToken);
    if (profile.userId !== shortLived.instagramUserId || profile.username?.toLowerCase() !== 'tozon_plaza') {
      return res.status(403).send('This Instagram account is not authorized for TOZON CRM');
    }
    await saveTozonInstagramConnection({
      instagramUserId: profile.userId,
      username: profile.username,
      accessToken: longLived.accessToken,
      expiresIn: longLived.expiresIn
    });
    return res.status(200).type('text/plain').send('Instagram @tozon_plaza connected. Return to TOZON CRM.');
  } catch {
    return res.status(503).send('Instagram authorization failed. Please retry from TOZON CRM.');
  }
});

export default router;
