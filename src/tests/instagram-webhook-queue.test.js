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
    const last = vi.fn().mockResolvedValue({ error: null, count: 1 });
    const middle = vi.fn().mockReturnValue({ eq: last });
    const eq = vi.fn().mockReturnValue({ eq: middle });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockReturnValue({ update });
    expect(await runInstagramWebhookQueue()).toEqual({ processed: 0, failed: 1 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', last_error: 'Processing failed', next_attempt_at: expect.any(String) }), { count: 'exact' });
    expect(eq).toHaveBeenCalledWith('id', 2);
    expect(middle).toHaveBeenCalledWith('status', 'processing');
    expect(last).toHaveBeenCalledWith('attempts', 1);
  });
  it('stops a batch after failure to avoid immediate reclaims', async () => {
    rpc.mockResolvedValue({ data: { id: 2, payload: {}, status: 'processing', attempts: 1 }, error: null });
    process.mockRejectedValue(new Error('temporary failure'));
    const last = vi.fn().mockResolvedValue({ error: null, count: 1 });
    const middle = vi.fn().mockReturnValue({ eq: last });
    const eq = vi.fn().mockReturnValue({ eq: middle });
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
    const last = vi.fn().mockResolvedValue({ error: { message: 'database unavailable' }, count: null });
    const middle = vi.fn().mockReturnValue({ eq: last });
    const eq = vi.fn().mockReturnValue({ eq: middle });
    from.mockReturnValue({ update: () => ({ eq }) });
    await expect(runInstagramWebhookQueue()).rejects.toThrow('failure recording failed');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('keeps a failed event available for later recovery after a worker crash', async () => {
    rpc.mockResolvedValueOnce({ data: { id: 21, payload: {}, status: 'processing', attempts: 2 }, error: null });
    process.mockRejectedValue(new Error('worker interrupted'));
    const last = vi.fn().mockResolvedValue({ error: null, count: 1 });
    const middle = vi.fn().mockReturnValue({ eq: last });
    const first = vi.fn().mockReturnValue({ eq: middle });
    const update = vi.fn().mockReturnValue({ eq: first });
    from.mockReturnValue({ update });
    expect(await runInstagramWebhookQueue({ limit: 1 })).toEqual({ processed: 0, failed: 1 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', next_attempt_at: expect.any(String) }), { count: 'exact' });
    expect(last).toHaveBeenCalledWith('attempts', 2);
  });
  it('rejects a claim with missing event payload', async () => {
    rpc.mockResolvedValue({ data: { id: 13, status: 'processing', attempts: 1 }, error: null });
    await expect(runInstagramWebhookQueue()).rejects.toThrow('Invalid Instagram webhook claim payload');
    expect(process).not.toHaveBeenCalled();
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
