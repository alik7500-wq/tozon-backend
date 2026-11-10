import { metaRead } from './meta-assets.client.js';
import { decryptSocialToken } from './social-token-crypto.js';
import { MetaEvents } from './meta-events.repository.js';
import { normalizeMetaForm } from './meta-webhook-events.js';
import { metaIngestEnabled } from './meta-webhook.router.js';
const enabled = () => metaIngestEnabled() && process.env.META_FORM_LEADS_ENABLED === 'true';
export async function processMetaFormsOnce() {
  if (!enabled()) return;
  const events = await MetaEvents.claim();
  for (const event of events) {
    if (!enabled()) return;
    try {
      const token = decryptSocialToken(event.encrypted_access_token);
      const form = await metaRead(`/${event.payload.leadgen_id}`, token, { fields: 'id,form_id,field_data,created_time' });
      if (String(form.id) !== event.payload.leadgen_id) throw new Error('FORM_ID_MISMATCH');
      const normalized = normalizeMetaForm(form, event.external_id);
      if (!normalized) {
        await MetaEvents.fail(event.id, event.lease_token, 'PHONE_MISSING_OR_INVALID', true);
        continue;
      }
      await MetaEvents.finish(event.id, event.lease_token, normalized);
    } catch (error) {
      // Fixed codes only: never persist Graph response errors, URLs, tokens or PII in logs.
      const code = error?.message === 'FORM_ID_MISMATCH' ? 'FORM_ID_MISMATCH' : 'META_FORM_RETRIEVAL_FAILED';
      await MetaEvents.fail(event.id, event.lease_token, code, code === 'FORM_ID_MISMATCH');
    }
  }
}
export function startMetaFormWorker() {
  if (!enabled()) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await processMetaFormsOnce(); }
    catch { console.error('[meta-worker] queue processing unavailable'); }
    finally { running = false; }
  };
  const timer = setInterval(tick, 10000);
  timer.unref(); void tick();
  return () => clearInterval(timer);
}
