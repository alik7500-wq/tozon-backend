import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc, from, process } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), process: vi.fn() }));
vi.mock('../db/connection.js', () => ({ getServiceDB: () => ({ rpc, from }) }));
vi.mock('../modules/integrations/instagram-message-processor.js', () => ({ processInstagramWebhookEvent: process }));
import { runInstagramWebhookQueue } from '../modules/integrations/instagram-webhook-queue.js';

describe('Instagram webhook queue', () => {
  beforeEach(() => vi.resetAllMocks());
  it('claims and processes pending events', async () => {
    rpc.mockResolvedValueOnce({ data: { id: 1, payload: {} }, error: null }).mockResolvedValueOnce({ data: null, error: null });
    process.mockResolvedValue({ processedMessages: 1 });
    expect(await runInstagramWebhookQueue()).toEqual({ processed: 1, failed: 0 });
    expect(process).toHaveBeenCalledOnce();
  });
  it('records failure without exposing customer payload', async () => {
    rpc.mockResolvedValueOnce({ data: { id: 2, payload: {} }, error: null }).mockResolvedValueOnce({ data: null, error: null });
    process.mockRejectedValue(new Error('private customer data'));
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    expect(await runInstagramWebhookQueue()).toEqual({ processed: 0, failed: 1 });
    expect(update).toHaveBeenCalledWith({ status: 'failed', last_error: 'Processing failed' });
  });
  it('stops a batch after failure to avoid immediate reclaims', async () => {
    rpc.mockResolvedValue({ data: { id: 2, payload: {} }, error: null });
    process.mockRejectedValue(new Error('temporary failure'));
    const eq = vi.fn().mockResolvedValue({ error: null });
    from.mockReturnValue({ update: () => ({ eq }) });
    expect(await runInstagramWebhookQueue({ limit: 20 })).toEqual({ processed: 0, failed: 1 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects unbounded batch size', async () => {
    await expect(runInstagramWebhookQueue({ limit: 101 })).rejects.toThrow(RangeError);
  });
});
