import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc, from, process } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), process: vi.fn() }));
vi.mock('../db/connection.js', () => ({ getServiceDB: () => ({ rpc, from }) }));
vi.mock('../modules/integrations/instagram-message-processor.js', () => ({ processInstagramWebhookEvent: process }));
import { runInstagramWebhookQueue } from '../modules/integrations/instagram-webhook-queue.js';

describe('Instagram webhook queue', () => {
  beforeEach(() => vi.resetAllMocks());
  it('claims and processes pending events', async () => {
    rpc.mockResolvedValueOnce({ data: { id: 1, payload: {}, status: 'processing', attempts: 1 }, error: null }).mockResolvedValueOnce({ data: null, error: null });
    process.mockResolvedValue({ processedMessages: 1 });
    expect(await runInstagramWebhookQueue()).toEqual({ processed: 1, failed: 0 });
    expect(process).toHaveBeenCalledOnce();
  });
  it('records failure without exposing customer payload', async () => {
    rpc.mockResolvedValueOnce({ data: { id: 2, payload: {}, status: 'processing', attempts: 1 }, error: null }).mockResolvedValueOnce({ data: null, error: null });
    process.mockRejectedValue(new Error('private customer data'));
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    expect(await runInstagramWebhookQueue()).toEqual({ processed: 0, failed: 1 });
    expect(update).toHaveBeenCalledWith({ status: 'failed', last_error: 'Processing failed' });
  });
  it('stops a batch after failure to avoid immediate reclaims', async () => {
    rpc.mockResolvedValue({ data: { id: 2, payload: {}, status: 'processing', attempts: 1 }, error: null });
    process.mockRejectedValue(new Error('temporary failure'));
    const eq = vi.fn().mockResolvedValue({ error: null });
    from.mockReturnValue({ update: () => ({ eq }) });
    expect(await runInstagramWebhookQueue({ limit: 20 })).toEqual({ processed: 0, failed: 1 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('stops without processing when the atomic database claim fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } });
    await expect(runInstagramWebhookQueue()).rejects.toThrow('queue claim failed');
    expect(process).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
  it('surfaces failure when event status cannot be recorded', async () => {
    rpc.mockResolvedValue({ data: { id: 9, payload: {}, status: 'processing', attempts: 1 }, error: null });
    process.mockRejectedValue(new Error('temporary error'));
    const eq = vi.fn().mockResolvedValue({ error: { message: 'database unavailable' } });
    from.mockReturnValue({ update: () => ({ eq }) });
    await expect(runInstagramWebhookQueue()).rejects.toThrow('failure recording failed');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects an invalid claim without processing customer data', async () => {
    rpc.mockResolvedValue({ data: { id: 11, payload: {}, status: 'pending', attempts: 0 }, error: null });
    await expect(runInstagramWebhookQueue()).rejects.toThrow('Invalid Instagram webhook claim state');
    expect(process).not.toHaveBeenCalled();
  });
  it('rejects unbounded batch size', async () => {
    await expect(runInstagramWebhookQueue({ limit: 101 })).rejects.toThrow(RangeError);
  });
});
