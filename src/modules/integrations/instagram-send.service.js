import { createHash } from 'node:crypto';
import { getServiceDB, getDB } from '../../db/connection.js';
import { InboxError } from './instagram-inbox.client.js';
import { liveInboxEnabled, saveInstagramThread } from './instagram-live.repository.js';

const getSafeDB = () => {
  try { return getServiceDB(); } catch { return getDB(); }
};

const VALID_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_:-]{8,128}$/;

const EXPLICIT_FAILURE_CODES = new Set([
  'INVALID_MESSAGE',
  'INVALID_CONTACT',
  'INVALID_ACCOUNT',
  'INSTAGRAM_REPLY_WINDOW_CLOSED',
  'INSTAGRAM_THREAD_OWNER_REQUIRED',
  'INSTAGRAM_PERMISSION_REQUIRED',
  'INSTAGRAM_RECONNECT_REQUIRED',
  'INSTAGRAM_ACCOUNT_MISMATCH',
  'INSTAGRAM_CONVERSATION_NOT_FOUND',
  'INSTAGRAM_RATE_LIMIT',
  'INSTAGRAM_ACCESS_DENIED'
]);

export function computeInstagramSendRequestHash({ actorUserId, accountId, contactId, text }) {
  const normalizedText = String(text ?? '').trim();
  const payload = JSON.stringify({
    actor_user_id: String(actorUserId),
    account_id: String(accountId),
    contact_id: String(contactId),
    text: normalizedText
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

async function updateSendOperation(operationId, patch) {
  const db = getSafeDB();
  const { data, error } = await db
    .from('crm_instagram_send_operations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', operationId)
    .select()
    .single();
  if (error) {
    throw new InboxError('INSTAGRAM_STORAGE_UNAVAILABLE', 503);
  }
  return data;
}

async function persistMessageToHistory(accountId, contactId, message) {
  if (!liveInboxEnabled()) {
    return true;
  }
  await saveInstagramThread(
    accountId,
    { contactId, lastMessage: message.text_content, updatedAt: message.created_at },
    [message]
  );
  return true;
}

async function tryRecoverSavedHistory(operation, accountId, contactId) {
  const payload = operation?.response_payload;
  const message = payload?.message;
  if (!operation?.external_message_id || !message) {
    return false;
  }
  try {
    await persistMessageToHistory(accountId, contactId, message);
    await updateSendOperation(operation.id, {
      status: 'CONFIRMED',
      saved_to_history: true,
      response_payload: { ...payload, saved: true, acceptedButUnsaved: false }
    });
    return true;
  } catch {
    return false;
  }
}

export async function executeIdempotentInstagramSend({
  actorUserId,
  accountId,
  contactId,
  text,
  idempotencyKey,
  client
}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 1000) {
    throw new InboxError('INVALID_MESSAGE', 400);
  }
  if (typeof idempotencyKey !== 'string' || !VALID_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new InboxError('INVALID_IDEMPOTENCY_KEY', 400);
  }

  const normalizedText = text.trim();
  const requestHash = computeInstagramSendRequestHash({
    actorUserId,
    accountId,
    contactId,
    text: normalizedText
  });

  const db = getSafeDB();
  const { data: claim, error: claimErr } = await db.rpc('fn_instagram_send_claim', {
    p_actor_user_id: Number(actorUserId),
    p_account_id: String(accountId),
    p_contact_id: String(contactId),
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
    p_normalized_text: normalizedText,
    p_lease_seconds: 60
  });

  if (claimErr || !claim) {
    throw new InboxError('INSTAGRAM_STORAGE_UNAVAILABLE', 503);
  }

  const action = claim.action;
  const op = claim.operation;

  if (action === 'CONFLICT') {
    throw new InboxError('IDEMPOTENCY_CONFLICT', 409);
  }
  if (action === 'IN_PROGRESS') {
    throw new InboxError('SEND_IN_PROGRESS', 409);
  }
  if (action === 'REPLAY_FAILED') {
    throw new InboxError(op.error_code || 'INSTAGRAM_REQUEST_FAILED', op.error_status || 409);
  }
  if (action === 'REPLAY_CONFIRMED') {
    if (!op.saved_to_history && op.external_message_id) {
      const recovered = await tryRecoverSavedHistory(op, accountId, contactId);
      if (recovered) {
        return {
          data: { ...(op.response_payload || {}), saved: true, acceptedButUnsaved: false },
          deliveryStatus: 'confirmed',
          replayed: true,
          idempotencyKey
        };
      }
      return {
        data: { ...(op.response_payload || {}), saved: false, acceptedButUnsaved: true },
        deliveryStatus: 'unknown',
        replayed: true,
        idempotencyKey
      };
    }
    return {
      data: op.response_payload || {},
      deliveryStatus: 'confirmed',
      replayed: true,
      idempotencyKey
    };
  }
  if (action === 'UNKNOWN') {
    // NEVER auto-retry external send on UNKNOWN
    return reconcileOperation(op, accountId, contactId, client, idempotencyKey);
  }

  // action === 'PROCEED': call external provider ONCE
  let sendResult;
  try {
    sendResult = await client.send(contactId, normalizedText);
  } catch (error) {
    const code = error instanceof InboxError ? error.code : 'INSTAGRAM_SEND_UNCONFIRMED';
    const status = error instanceof InboxError ? error.status : 503;

    if (EXPLICIT_FAILURE_CODES.has(code)) {
      try {
        await updateSendOperation(op.id, {
          status: 'FAILED',
          error_code: code,
          error_status: status
        });
      } catch {
        // Storage failure after provider call still must not look like a clean retryable error
      }
      throw error instanceof InboxError ? error : new InboxError(code, status);
    }

    // Timeout / lost response / 5xx: result is UNKNOWN, never auto-retry
    try {
      await updateSendOperation(op.id, {
        status: 'UNKNOWN',
        error_code: code,
        error_status: status
      });
    } catch {
      // Even if storage update fails after possible send, return unknown (NEVER safe retry)
    }
    return {
      data: {
        acceptedButUnsaved: false,
        reconciliationRequired: true,
        nextAction: 'Проверьте переписку в Instagram и выполните сверку перед новой отправкой.'
      },
      deliveryStatus: 'unknown',
      idempotencyKey
    };
  }

  // Provider accepted (or live service returned { message, saved })
  const message = sendResult?.message || {
    message_id: sendResult?.messageId,
    text_content: normalizedText,
    created_at: new Date().toISOString(),
    is_echo: true,
    attachments: [],
    shares: [],
    reactions: [],
    contentUnavailable: false
  };
  const externalMessageId = message?.message_id || sendResult?.messageId || null;

  let saved = sendResult?.saved !== false;
  if (saved && !sendResult?.message) {
    try {
      await persistMessageToHistory(accountId, contactId, message);
      saved = true;
    } catch {
      saved = false;
    }
  }

  const responsePayload = {
    ...sendResult,
    message,
    saved,
    acceptedButUnsaved: !saved
  };

  try {
    await updateSendOperation(op.id, {
      status: 'CONFIRMED',
      external_message_id: externalMessageId ? String(externalMessageId) : null,
      saved_to_history: saved,
      response_payload: responsePayload
    });
  } catch {
    // Provider already accepted: if storage fails, return unknown (acceptedButUnsaved) instead of 503 retryable error
    return {
      data: { ...responsePayload, saved: false, acceptedButUnsaved: true },
      deliveryStatus: 'unknown',
      idempotencyKey
    };
  }

  return {
    data: responsePayload,
    deliveryStatus: saved ? 'confirmed' : 'unknown',
    idempotencyKey
  };
}

async function reconcileOperation(op, accountId, contactId, client, idempotencyKey) {
  if (op.status === 'CONFIRMED') {
    if (!op.saved_to_history && op.external_message_id) {
      const recovered = await tryRecoverSavedHistory(op, accountId, contactId);
      if (recovered) {
        return {
          data: { ...(op.response_payload || {}), saved: true, acceptedButUnsaved: false },
          deliveryStatus: 'confirmed',
          reconciled: true,
          idempotencyKey
        };
      }
      return {
        data: { ...(op.response_payload || {}), saved: false, acceptedButUnsaved: true },
        deliveryStatus: 'unknown',
        reconciled: false,
        idempotencyKey
      };
    }
    return {
      data: op.response_payload || {},
      deliveryStatus: 'confirmed',
      reconciled: true,
      idempotencyKey
    };
  }

  // Authoritative reconciliation ONLY by external_message_id (never by text+time match alone)
  if (op.external_message_id && typeof client?.messages === 'function') {
    try {
      const history = await client.messages(contactId);
      const matched = (history?.data || []).find(
        (m) => String(m.message_id) === String(op.external_message_id)
      );
      if (matched) {
        await persistMessageToHistory(accountId, contactId, matched);
        const payload = { message: matched, saved: true, acceptedButUnsaved: false };
        await updateSendOperation(op.id, {
          status: 'CONFIRMED',
          saved_to_history: true,
          response_payload: payload
        });
        return {
          data: payload,
          deliveryStatus: 'confirmed',
          reconciled: true,
          idempotencyKey
        };
      }
    } catch {
      // Keep UNKNOWN on reconciliation error
    }
  }

  return {
    data: {
      acceptedButUnsaved: Boolean(op.external_message_id && !op.saved_to_history),
      reconciliationRequired: true,
      nextAction: 'Не удалось достоверно подтвердить доставку. Проверьте переписку в Instagram перед созданием новой отправки.'
    },
    deliveryStatus: 'unknown',
    reconciled: false,
    idempotencyKey
  };
}

export async function reconcileInstagramSend({
  actorUserId,
  accountId,
  contactId,
  idempotencyKey,
  client
}) {
  if (typeof idempotencyKey !== 'string' || !VALID_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new InboxError('INVALID_IDEMPOTENCY_KEY', 400);
  }
  const db = getSafeDB();
  const { data: op, error } = await db
    .from('crm_instagram_send_operations')
    .select('*')
    .eq('actor_user_id', Number(actorUserId))
    .eq('account_id', String(accountId))
    .eq('contact_id', String(contactId))
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new InboxError('INSTAGRAM_STORAGE_UNAVAILABLE', 503);
  }
  if (!op) {
    throw new InboxError('SEND_OPERATION_NOT_FOUND', 404);
  }
  return reconcileOperation(op, accountId, contactId, client, idempotencyKey);
}
