import { describe, expect, it } from 'vitest';
import { extractInstagramMessages } from '../modules/integrations/instagram-message-normalizer.js';

describe('Instagram message normalization', () => {
  it('extracts incoming text and message ID', () => {
    const events = extractInstagramMessages({ object: 'instagram', entry: [{ id: 'business', messaging: [{ sender: { id: 'customer' }, recipient: { id: 'business' }, timestamp: 1234, message: { mid: 'm1', text: 'Здравствуйте' } }] }] });
    expect(events).toEqual([{ messageId: 'm1', senderId: 'customer', recipientId: 'business', instagramAccountId: 'business', timestamp: 1234, text: 'Здравствуйте', isEcho: false, hasAttachments: false }]);
  });
  it('ignores delivery receipts and malformed events', () => {
    expect(extractInstagramMessages({ object: 'instagram', entry: [{ messaging: [{ read: { watermark: 1 } }, { message: { text: 'no ID' } }] }] })).toEqual([]);
    expect(extractInstagramMessages(null)).toEqual([]);
  });
  it('marks echo and attachments without leaking attachment URLs', () => {
    const [message] = extractInstagramMessages({ object: 'instagram', entry: [{ messaging: [{ sender: { id: 'business' }, recipient: { id: 'customer' }, message: { mid: 'm2', is_echo: true, attachments: [{ payload: { url: 'private' } }] } }] }] });
    expect(message.isEcho).toBe(true);
    expect(message.hasAttachments).toBe(true);
    expect(JSON.stringify(message)).not.toContain('private');
  });
});
