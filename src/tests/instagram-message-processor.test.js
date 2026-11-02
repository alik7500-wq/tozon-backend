import { describe, expect, it, vi, beforeEach } from 'vitest';
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../db/connection.js', () => ({ getServiceDB: () => ({ from }) }));
import { processInstagramWebhookEvent } from '../modules/integrations/instagram-message-processor.js';

describe('Instagram message processor', () => {
  beforeEach(() => { vi.resetAllMocks(); process.env.INSTAGRAM_INBOX_ACCOUNT_ID = '17841447499018452'; });
  it('stores each message with conflict-safe key then marks event processed', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockImplementation(table => table === 'tozon_instagram_messages' ? { upsert } : { update });
    const result = await processInstagramWebhookEvent({ id: 42, payload: { object: 'instagram', entry: [{ id: '17841447499018452', messaging: [{ sender: { id: 'customer' }, recipient: { id: '17841447499018452' }, message: { mid: 'mid-1', text: 'hello' } }] }] } });
    expect(result.processedMessages).toBe(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ message_id: 'mid-1', text_content: 'hello' }), { onConflict: 'message_id', ignoreDuplicates: true });
    expect(eq).toHaveBeenCalledWith('id', 42);
  });
  it('does not store messages belonging to another Instagram account', async () => {
    const upsert = vi.fn();
    const eq = vi.fn().mockResolvedValue({ error: null });
    from.mockImplementation(table => table === 'tozon_instagram_messages' ? { upsert } : { update: () => ({ eq }) });
    const result = await processInstagramWebhookEvent({ id: 8, payload: { object: 'instagram', entry: [{ id: '99999999999', messaging: [{ sender: { id: '12345678901' }, recipient: { id: '99999999999' }, message: { mid: 'other-mid' } }] }] } });
    expect(result.processedMessages).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith('id', 8);
  });
  it('does not mark events processed if TOZON account is not configured', async () => {
    delete process.env.INSTAGRAM_INBOX_ACCOUNT_ID;
    await expect(processInstagramWebhookEvent({ id: 7, payload: { object: 'instagram', entry: [] } })).rejects.toThrow('configuration missing');
    expect(from).not.toHaveBeenCalled();
  });
  it('rejects an event without a valid processing lease', async () => {
    await expect(processInstagramWebhookEvent({ id: 12, status: 'pending', attempts: 0, payload: {} })).rejects.toThrow('Stored webhook event required');
    expect(from).not.toHaveBeenCalled();
  });
  it('never marks event processed when message storage fails', async () => {
    const update = vi.fn();
    from.mockImplementation(table => table === 'tozon_instagram_messages' ? { upsert: vi.fn().mockResolvedValue({ error: { message: 'offline' } }) } : { update });
    await expect(processInstagramWebhookEvent({ id: 1, payload: { object: 'instagram', entry: [{ id: '17841447499018452', messaging: [{ sender: { id: 'a' }, recipient: { id: 'b' }, message: { mid: 'm' } }] }] } })).rejects.toThrow('persistence failed');
    expect(update).not.toHaveBeenCalled();
  });
});
