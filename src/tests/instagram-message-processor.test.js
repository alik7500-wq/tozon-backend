import { describe, expect, it, vi, beforeEach } from 'vitest';
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../db/connection.js', () => ({ getServiceDB: () => ({ from }) }));
import { processInstagramWebhookEvent } from '../modules/integrations/instagram-message-processor.js';

describe('Instagram message processor', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it('stores each message with conflict-safe key then marks event processed', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    from.mockImplementation(table => table === 'tozon_instagram_messages' ? { upsert } : { update });
    const result = await processInstagramWebhookEvent({ id: 42, payload: { object: 'instagram', entry: [{ id: 'business', messaging: [{ sender: { id: 'customer' }, recipient: { id: 'business' }, message: { mid: 'mid-1', text: 'hello' } }] }] } });
    expect(result.processedMessages).toBe(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ message_id: 'mid-1', text_content: 'hello' }), { onConflict: 'message_id', ignoreDuplicates: true });
    expect(eq).toHaveBeenCalledWith('id', 42);
  });
  it('never marks event processed when message storage fails', async () => {
    const update = vi.fn();
    from.mockImplementation(table => table === 'tozon_instagram_messages' ? { upsert: vi.fn().mockResolvedValue({ error: { message: 'offline' } }) } : { update });
    await expect(processInstagramWebhookEvent({ id: 1, payload: { object: 'instagram', entry: [{ messaging: [{ sender: { id: 'a' }, recipient: { id: 'b' }, message: { mid: 'm' } }] }] } })).rejects.toThrow('persistence failed');
    expect(update).not.toHaveBeenCalled();
  });
});
