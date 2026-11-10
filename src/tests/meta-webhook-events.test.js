import { describe, expect, it } from 'vitest';
import { normalizeMetaForm, normalizeMetaWebhook } from '../modules/integrations/meta-webhook-events.js';
describe('Meta webhook normalization', () => {
  const message = (mid = 'm:fixture') => ({ object: 'instagram', entry: [{ id: '31', messaging: [
    { sender: { id: '51' }, recipient: { id: '31' }, timestamp: 1700000000000, message: { mid, text: 'Fixture question', attachments: [{ payload: { url: 'https://untrusted.invalid' } }] } }
  ] }] });
  it('uses stable per-message keys regardless of batch shape or delivery time', () => {
    const a = message(); const b = message(); b.entry[0].time = 123;
    expect(normalizeMetaWebhook(a)[0].event_key).toBe(normalizeMetaWebhook(b)[0].event_key);
    expect(normalizeMetaWebhook(a)[0]).toMatchObject({ channel: 'INSTAGRAM_MESSAGES', external_id: '31', payload: { text: 'Fixture question', has_attachments: true } });
    expect(JSON.stringify(normalizeMetaWebhook(a))).not.toContain('untrusted.invalid');
  });
  it('drops echoes and read receipts without inventing inquiries', () => {
    const a = message(); a.entry[0].messaging[0].message.is_echo = true;
    a.entry[0].messaging.push({ read: { watermark: 1 } });
    expect(normalizeMetaWebhook(a)).toEqual([]);
  });
  it('rejects a forged recipient and bounds a batch', () => {
    const a = message(); a.entry[0].messaging[0].recipient.id = '999';
    expect(() => normalizeMetaWebhook(a)).toThrow('INVALID_MESSAGE_PARTICIPANTS');
    const b = message(); b.entry[0].messaging = Array.from({ length: 201 }, (_, index) => message(String(index)).entry[0].messaging[0]);
    expect(() => normalizeMetaWebhook(b)).toThrow('INVALID_EVENT');
  });
  it('routes leadgen notifications by form and verifies the Page identifier', () => {
    const payload = { object: 'page', entry: [{ id: '21', changes: [{ field: 'leadgen', value: { page_id: '21', form_id: '41', leadgen_id: '101', created_time: 1700000000 } }] }] };
    expect(normalizeMetaWebhook(payload)[0]).toMatchObject({ channel: 'FACEBOOK_FORM', external_id: '41', page_id: '21', payload: { leadgen_id: '101' } });
    payload.entry[0].changes[0].value.page_id = '999';
    expect(() => normalizeMetaWebhook(payload)).toThrow('INVALID_FORM_EVENT');
  });
  it('keeps Instagram and Facebook comments separate', () => {
    const ig = { object: 'instagram', entry: [{ id: '31', changes: [{ field: 'comments', value: { id: '81', text: 'Fixture IG', from: { id: '51', username: 'fixture' } } }] }] };
    const fb = { object: 'page', entry: [{ id: '21', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: '21_81', message: 'Fixture FB', from: { id: '51', name: 'Fixture' } } }] }] };
    expect(normalizeMetaWebhook(ig)[0].channel).toBe('INSTAGRAM_COMMENTS');
    expect(normalizeMetaWebhook(fb)[0].channel).toBe('FACEBOOK_COMMENTS');
    fb.entry[0].changes[0].value.verb = 'remove'; expect(normalizeMetaWebhook(fb)).toEqual([]);
  });
  it('does not invent a phone when a form lacks one and rejects another form', () => {
    expect(normalizeMetaForm({ form_id: '41', field_data: [{ name: 'full_name', values: ['Fixture'] }] }, '41')).toBeNull();
    expect(() => normalizeMetaForm({ form_id: '42', field_data: [] }, '41')).toThrow('FORM_ID_MISMATCH');
  });
  it('normalizes a real phone and combines first/last names from form fields', () => {
    expect(normalizeMetaForm({ form_id: '41', created_time: '2026-01-01', field_data: [
      { name: 'first_name', values: ['Fixture'] }, { name: 'last_name', values: ['Lead'] },
      { name: 'phone_number', values: ['(900) 123-456'] }, { name: 'rooms', values: ['2'] }
    ] }, '41')).toMatchObject({ phone: '+992900123456', full_name: 'Fixture Lead', notes: 'rooms: 2' });
  });
});
