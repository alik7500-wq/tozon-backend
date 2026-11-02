import { describe, expect, it, vi, beforeEach } from 'vitest';
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../db/connection.js', () => ({ getServiceDB: () => ({ from }) }));
import { processInstagramWebhookEvent } from '../modules/integrations/instagram-message-processor.js';

const event = (id, entry = []) => ({ id, status: 'processing', attempts: 1, payload: { object: 'instagram', entry } });
function mockCompletion(count = 1) {
  const last = vi.fn().mockResolvedValue({ error: null, count });
  const middle = vi.fn().mockReturnValue({ eq: last });
  const first = vi.fn().mockReturnValue({ eq: middle });
  const update = vi.fn().mockReturnValue({ eq: first });
  return { update, first, middle, last };
}

describe('Instagram message processor', () => {
  beforeEach(() => { vi.resetAllMocks(); process.env.INSTAGRAM_INBOX_ACCOUNT_ID = '17841447499018452'; });
  it('stores a message and completes the matching claim', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const completion = mockCompletion();
    from.mockImplementation(table => table === 'tozon_instagram_messages' ? { upsert } : { update: completion.update });
    const entry = [{ id: '17841447499018452', messaging: [{ sender: { id: 'customer' }, recipient: { id: '17841447499018452' }, message: { mid: 'mid-1', text: 'hello' } }] }];
    expect(await processInstagramWebhookEvent(event(42, entry))).toEqual({ processedMessages: 1 });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ message_id: 'mid-1', text_content: 'hello' }), { onConflict: 'message_id', ignoreDuplicates: true });
    expect(completion.first).toHaveBeenCalledWith('id', 42);
    expect(completion.middle).toHaveBeenCalledWith('status', 'processing');
    expect(completion.last).toHaveBeenCalledWith('attempts', 1);
  });
  it('does not persist messages from another Instagram account', async () => {
    const upsert = vi.fn();
    const completion = mockCompletion();
    from.mockImplementation(table => table === 'tozon_instagram_messages' ? { upsert } : { update: completion.update });
    const entry = [{ id: '99999999999', messaging: [{ sender: { id: '12345678901' }, recipient: { id: '99999999999' }, message: { mid: 'other-mid' } }] }];
    expect(await processInstagramWebhookEvent(event(8, entry))).toEqual({ processedMessages: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('fails closed when account configuration is missing', async () => {
    delete process.env.INSTAGRAM_INBOX_ACCOUNT_ID;
    await expect(processInstagramWebhookEvent(event(7))).rejects.toThrow('configuration missing');
    expect(from).not.toHaveBeenCalled();
  });
  it('rejects an event without an active claim', async () => {
    await expect(processInstagramWebhookEvent({ ...event(12), status: 'pending' })).rejects.toThrow('Stored webhook event required');
    expect(from).not.toHaveBeenCalled();
  });
  it('never completes the event if message storage fails', async () => {
    const completion = mockCompletion();
    from.mockImplementation(table => table === 'tozon_instagram_messages' ? { upsert: vi.fn().mockResolvedValue({ error: { message: 'offline' } }) } : { update: completion.update });
    const entry = [{ id: '17841447499018452', messaging: [{ sender: { id: 'a' }, recipient: { id: 'b' }, message: { mid: 'm' } }] }];
    await expect(processInstagramWebhookEvent(event(1, entry))).rejects.toThrow('persistence failed');
    expect(completion.update).not.toHaveBeenCalled();
  });
  it('rejects completion when a newer attempt owns the event', async () => {
    const completion = mockCompletion(0);
    from.mockReturnValue({ update: completion.update });
    await expect(processInstagramWebhookEvent(event(14))).rejects.toThrow('completion update failed');
  });
});
