import { describe, expect, it, vi } from 'vitest';
import { startInstagramWebhookWorker } from '../modules/integrations/instagram-webhook-worker.js';

describe('Instagram worker lifecycle', () => {
  it('is disabled by default without starting timers', () => {
    const schedule = vi.fn();
    const worker = startInstagramWebhookWorker({ enabled: false, schedule });
    expect(worker.started).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });
  it('pauses polling after a failed batch', async () => {
    let callback;
    const run = vi.fn().mockResolvedValue({ processed: 0, failed: 1 });
    const schedule = fn => { callback = fn; return 1; };
    const worker = startInstagramWebhookWorker({ enabled: true, schedule, run });
    await Promise.resolve();
    await Promise.resolve();
    callback();
    expect(run).toHaveBeenCalledTimes(1);
    worker.stop();
  });
  it('does not poll again during cooldown after a thrown database error', async () => {
    let callback;
    const run = vi.fn().mockRejectedValue(new Error('database offline'));
    const schedule = fn => { callback = fn; return 2; };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const worker = startInstagramWebhookWorker({ enabled: true, schedule, run });
      await Promise.resolve();
      await Promise.resolve();
      callback();
      expect(run).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('INSTAGRAM_WEBHOOK_WORKER_ERROR');
      worker.stop();
    } finally { log.mockRestore(); }
  });
  it('rejects polling intervals shorter than five seconds', () => {
    expect(() => startInstagramWebhookWorker({ enabled: true, intervalMs: 1000 })).toThrow(RangeError);
  });
  it('prevents overlapping runs and stops timer', async () => {
    let callback;
    let release;
    const run = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const schedule = vi.fn(fn => { callback = fn; return 7; });
    const cancel = vi.fn();
    const worker = startInstagramWebhookWorker({ enabled: true, schedule, cancel, run });
    expect(worker.started).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    callback();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    callback();
    expect(run).toHaveBeenCalledTimes(2);
    worker.stop();
    expect(cancel).toHaveBeenCalledWith(7);
    release();
  });
});
