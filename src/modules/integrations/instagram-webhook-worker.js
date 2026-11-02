import { runInstagramWebhookQueue } from './instagram-webhook-queue.js';

// Opt-in worker. Disabled until Meta and production rollout are explicitly validated.
export function startInstagramWebhookWorker({ enabled = process.env.INSTAGRAM_WEBHOOK_WORKER_ENABLED === 'true', intervalMs = 15000, run = runInstagramWebhookQueue, schedule = setInterval, cancel = clearInterval } = {}) {
  if (!enabled) return { started: false, stop() {} };
  if (!Number.isInteger(intervalMs) || intervalMs < 5000) throw new RangeError('Invalid Instagram worker interval');
  let running = false;
  let stopped = false;
  let retryAfter = 0;
  const tick = async () => {
    if (running || stopped || Date.now() < retryAfter) return;
    running = true;
    try {
      const result = await run({ limit: 20 });
      if (result?.failed > 0) retryAfter = Date.now() + 60000;
    } catch {
      retryAfter = Date.now() + 60000;
      console.error('INSTAGRAM_WEBHOOK_WORKER_ERROR');
    } finally {
      running = false;
    }
  };
  const handle = schedule(() => { void tick(); }, intervalMs);
  void tick();
  return { started: true, stop() { stopped = true; cancel(handle); } };
}
