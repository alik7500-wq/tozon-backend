import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { UsersRepository } from '../users/users.repository.js';
import { hasSection, isMatrixUser } from '../../middleware/sectionAccess.js';
import { createOAuthState } from './social-oauth-state.js';
import { MetaSources } from './meta-sources.repository.js';
import { discoverMetaAssets } from './meta-assets.client.js';
import { MetaEvents } from './meta-events.repository.js';
import { subscribeMetaLeadgen } from './meta-form-subscription.client.js';
import { decryptSocialToken } from './social-token-crypto.js';
import { metaIngestEnabled } from './meta-webhook.router.js';
import { checkMetaCredentials } from './meta-credentials.client.js';

const router = Router();
const enabled = () => process.env.META_SOURCE_ROUTING_ENABLED === 'true';
export const canManageMetaSources = user => Boolean(user?.is_active && ['ADMIN', 'DIRECTOR'].includes(user.role) &&
  (!isMatrixUser(user) || hasSection(user, 'automation.view', true)));
const unavailable = res => res.status(503).json({ status: 'error', message: 'Настройка источников Meta пока недоступна. Подключение не подтверждено.' });
function config() {
  const id = process.env.META_INSTAGRAM_APP_ID;
  const secret = process.env.META_INSTAGRAM_APP_SECRET;
  const redirect = process.env.META_SOURCES_REDIRECT_URI;
  const configId = process.env.META_SOURCES_CONFIG_ID;
  if (!/^\d+$/.test(id || '') || !secret || !/^\d+$/.test(configId || '')) throw new Error('META_CONFIG_MISSING');
  const url = new URL(redirect);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/api/integrations/meta/callback') throw new Error('META_REDIRECT_INVALID');
  return { id, secret, redirect, configId };
}
async function exchange(code) {
  const { id, secret, redirect } = config();
  const url = new URL('https://graph.facebook.com/v25.0/oauth/access_token');
  for (const [key, value] of Object.entries({ client_id: id, client_secret: secret, redirect_uri: redirect, code })) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error || typeof body?.access_token !== 'string') throw new Error('META_TOKEN_EXCHANGE_FAILED');
  return body.access_token;
}

// Registered before authentication: one-use state binds the callback to a CRM administrator.
router.get('/callback', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!enabled()) return unavailable(res);
  if (typeof req.query.state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(req.query.state)) return res.sendStatus(400);
  let stage = 'state';
  try {
    const initiated = await MetaSources.consumeState(req.query.state);
    if (!initiated) return res.status(403).type('text/plain').send('Authorization expired. Start again from CRM.');
    const user = await UsersRepository.findById(initiated.owner_user_id);
    if (!canManageMetaSources(user)) return res.sendStatus(403);
    if (req.query.error || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 2048) {
      return res.status(400).type('text/plain').send('Authorization cancelled. Return to CRM.');
    }
    stage = 'exchange_code';
    const token = await exchange(req.query.code);
    stage = 'discover_assets';
    const catalogue = await discoverMetaAssets(token);
    stage = 'save_catalogue';
    await MetaSources.sync(user.id, token, catalogue, req.query.state);
    return res.type('text/plain').send('Meta connected. Return to CRM > Automation and assign each source to a project.');
  } catch {
    console.error('[meta-sources] callback failed at stage:', stage);
    return res.status(503).type('text/plain').send('Meta connection failed. Return to CRM and retry.');
  }
});

router.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!canManageMetaSources(req.user)) return res.sendStatus(403);
  next();
});
router.post('/preflight', async (_req, res) => {
  return res.json({ status: 'success', data: await checkMetaCredentials() });
});
router.get('/sources', async (req, res) => {
  if (!enabled()) return res.json({ status: 'success', data: { enabled: false, connection: null, sources: [] } });
  try { return res.json({ status: 'success', data: { enabled: true, ingestEnabled: metaIngestEnabled(), formLeadsEnabled: process.env.META_FORM_LEADS_ENABLED === 'true', ...await MetaSources.list(req.user.id) } }); }
  catch { return unavailable(res); }
});
router.post('/sources/:id/subscribe', async (req, res) => {
  if (!metaIngestEnabled()) return unavailable(res);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return res.sendStatus(400);
  try {
    const source = await MetaSources.formSubscriptionContext(req.user.id, req.params.id);
    if (!source?.encrypted_access_token) return res.sendStatus(404);
    await subscribeMetaLeadgen(source.page_id, decryptSocialToken(source.encrypted_access_token));
    return res.json({ status: 'success', data: { subscribed: true } });
  } catch { return res.status(503).json({ message: 'Подписка не подтверждена. Проверьте доступ к странице и настройку Webhooks в Meta.' }); }
});
router.get('/events', async (req, res) => {
  if (!enabled()) return unavailable(res);
  const project = req.query.projectId;
  if (project !== undefined && (typeof project !== 'string' || !/^[1-9]\d{0,18}$/.test(project) || BigInt(project) > 9223372036854775807n)) return res.sendStatus(400);
  try { return res.json({ status: 'success', data: { events: await MetaEvents.list(req.user.id, project || null) } }); }
  catch { return unavailable(res); }
});
router.post('/events/:id/assign', async (req, res) => {
  if (!enabled()) return unavailable(res);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return res.sendStatus(400);
  const project = req.body?.expectedProjectId;
  if (typeof project !== 'string' || !/^[1-9]\d{0,18}$/.test(project) || BigInt(project) > 9223372036854775807n) return res.sendStatus(400);
  try {
    if (!await MetaEvents.assign(req.user.id, req.params.id, project)) return res.status(409).json({ message: 'Источник или привязка изменились. Обновите список.' });
    return res.json({ status: 'success' });
  } catch { return unavailable(res); }
});
router.post('/connect', async (req, res) => {
  if (!enabled()) return unavailable(res);
  try {
    const { id, redirect, configId } = config();
    const { state } = createOAuthState();
    await MetaSources.saveState(state, req.user.id);
    const url = new URL('https://www.facebook.com/dialog/oauth');
    for (const [key, value] of Object.entries({ client_id: id, redirect_uri: redirect, config_id: configId, response_type: 'code', state })) url.searchParams.set(key, value);
    return res.json({ status: 'success', data: { authorizationUrl: url.toString() } });
  } catch { return unavailable(res); }
});
router.patch('/sources/:id', async (req, res) => {
  if (!enabled()) return unavailable(res);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return res.sendStatus(400);
  const project = req.body?.projectId;
  if (project !== null && (typeof project !== 'string' || !/^[1-9]\d{0,18}$/.test(project) || BigInt(project) > 9223372036854775807n)) return res.sendStatus(400);
  try {
    const changed = await MetaSources.bind(req.user.id, req.params.id, project);
    if (!changed) return res.status(404).json({ message: 'Источник или доступный объект не найден. Обновите список.' });
    return res.json({ status: 'success' });
  } catch { return unavailable(res); }
});
router.delete('/connection', async (req, res) => {
  if (!enabled()) return unavailable(res);
  try { await MetaSources.disconnect(req.user.id); return res.sendStatus(204); }
  catch { return unavailable(res); }
});
export default router;
