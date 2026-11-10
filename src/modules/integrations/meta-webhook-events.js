import { createHash } from 'node:crypto';

const id = value => typeof value === 'string' && /^[0-9]{1,30}$/.test(value);
const text = (value, limit = 8000) => typeof value === 'string' ? value.slice(0, limit) : '';
const stamp = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const milliseconds = n < 1e11 ? n * 1000 : n;
  return milliseconds < 8640000000000000 ? new Date(milliseconds).toISOString() : null;
};
export function normalizeMetaWebhook(body) {
  if (!['page', 'instagram'].includes(body?.object) || !Array.isArray(body.entry)) throw new TypeError('INVALID_WEBHOOK');
  const events = [];
  const add = (channel, externalId, pageId, eventId, payload) => {
    if (!id(externalId) || typeof eventId !== 'string' || !eventId || eventId.length > 2048 || events.length >= 200) throw new TypeError('INVALID_EVENT');
    events.push({ channel, external_id: externalId, page_id: pageId,
      event_key: createHash('sha256').update(JSON.stringify([channel, externalId, eventId])).digest('hex'), payload });
  };
  for (const entry of body.entry) {
    if (!id(entry?.id) || (entry.messaging !== undefined && !Array.isArray(entry.messaging)) ||
        (entry.changes !== undefined && !Array.isArray(entry.changes))) throw new TypeError('INVALID_ENTRY');
    const pageId = body.object === 'page' ? entry.id : null;
    for (const item of entry.messaging || []) {
      const message = item?.message;
      // Delivery, read receipts and outgoing echoes never become incoming inquiries.
      if (!message || message.is_echo || message.is_deleted) continue;
      if (item.recipient?.id !== entry.id || !id(item.sender?.id)) throw new TypeError('INVALID_MESSAGE_PARTICIPANTS');
      add(body.object === 'instagram' ? 'INSTAGRAM_MESSAGES' : 'FACEBOOK_MESSAGES', entry.id, pageId, message.mid, {
        kind: 'MESSAGE', message_id: message.mid, from_id: item.sender.id,
        text: text(message.text), has_attachments: Array.isArray(message.attachments) && message.attachments.length > 0,
        occurred_at: stamp(item.timestamp)
      });
    }
    for (const change of entry.changes || []) {
      const value = change?.value;
      if (body.object === 'page' && change?.field === 'leadgen') {
        if (!id(value?.form_id) || !id(value?.leadgen_id) || value.page_id !== entry.id) throw new TypeError('INVALID_FORM_EVENT');
        add('FACEBOOK_FORM', value.form_id, entry.id, value.leadgen_id, {
          kind: 'FORM', leadgen_id: value.leadgen_id, form_id: value.form_id,
          occurred_at: stamp(value.created_time)
        });
      } else if (body.object === 'instagram' && change?.field === 'comments') {
        add('INSTAGRAM_COMMENTS', entry.id, null, value?.id, {
          kind: 'COMMENT', comment_id: value.id, from_id: id(value.from?.id) ? value.from.id : null,
          from_name: text(value.from?.username, 200), text: text(value.text), occurred_at: stamp(entry.time)
        });
      } else if (body.object === 'page' && change?.field === 'feed' && value?.item === 'comment' && value.verb === 'add') {
        add('FACEBOOK_COMMENTS', entry.id, entry.id, value.comment_id, {
          kind: 'COMMENT', comment_id: value.comment_id, from_id: id(value.from?.id) ? value.from.id : null,
          from_name: text(value.from?.name, 200), text: text(value.message), occurred_at: stamp(value.created_time)
        });
      }
    }
  }
  return events;
}

export function normalizeMetaForm(form, expectedFormId) {
  if (String(form?.form_id) !== expectedFormId || !Array.isArray(form.field_data)) throw new Error('FORM_ID_MISMATCH');
  const fields = new Map(form.field_data.filter(field => typeof field?.name === 'string' && Array.isArray(field.values))
    .map(field => [field.name, text(field.values[0], 1000)]));
  let phone = (fields.get('phone_number') || fields.get('phone') || '').replace(/[^0-9]/g, '');
  if (phone.startsWith('00')) phone = phone.slice(2);
  if (phone.length === 9) phone = '992' + phone;
  if (!/^[1-9][0-9]{6,14}$/.test(phone)) return null;
  const name = fields.get('full_name') || [fields.get('first_name'), fields.get('last_name')].filter(Boolean).join(' ') || 'Заявка Facebook';
  return { full_name: name.slice(0, 200), phone: '+' + phone,
    notes: [...fields].filter(([key]) => !['phone_number', 'phone', 'full_name', 'first_name', 'last_name'].includes(key))
      .map(([key, value]) => `${key}: ${value}`).join('\n').slice(0, 4000),
    submitted_at: typeof form.created_time === 'string' ? form.created_time.slice(0, 100) : null };
}
