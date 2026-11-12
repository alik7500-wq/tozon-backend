import test from 'node:test';
import assert from 'node:assert/strict';
import { TAJIK_SMS_TEMPLATES, normalizeSmsLanguage, resolveSmsTemplateLanguage } from '../smsLanguages.js';

test('new SMS language defaults to Tajik; Russian is opt-in', () => {
  assert.equal(normalizeSmsLanguage(), 'tj');
  assert.equal(normalizeSmsLanguage('tj'), 'tj');
  assert.equal(normalizeSmsLanguage('ru'), 'ru');
  assert.throws(() => normalizeSmsLanguage('en'), /Unsupported/);
});

test('Russian canonical text is preserved verbatim', () => {
  assert.equal(resolveSmsTemplateLanguage({ code: 'PAYMENT_REMINDER', language: 'ru', russianText: 'Russian canonical text' }), 'Russian canonical text');
});

test('Tajik texts retain the critical financial placeholders', () => {
  for (const [code, keys] of Object.entries({
    PAYMENT_RECEIVED: ['client_name', 'contract_number', 'payment_amount', 'payment_currency', 'total_paid', 'remaining_balance'],
    PAYMENT_REMINDER: ['client_name', 'contract_number', 'payment_amount', 'payment_date', 'currency'],
    DEBTOR_REMINDER: ['client_name', 'contract_number', 'overdue_amount', 'currency'],
    DEAL_INFO: ['client_name', 'contract_number', 'contract_total', 'total_paid', 'remaining_balance']
  })) {
    for (const key of keys) assert.match(TAJIK_SMS_TEMPLATES[code], new RegExp('\\{\\{' + key + '\\}\\}'), code + ':' + key);
  }
});

test('unsupported Tajik template fails closed instead of silently sending Russian', () => {
  assert.throws(() => resolveSmsTemplateLanguage({ code: 'UNSUPPORTED', language: 'tj', russianText: 'Russian' }), /unavailable/);
});

// Canonical placeholder sets captured from the 16 active production Russian templates.
// This test never connects to production and never sends SMS.
const CANONICAL_PLACEHOLDERS = {
  "BIRTHDAY": [
    "client_name"
  ],
  "CLIENT_WELCOME": [
    "client_name"
  ],
  "CONTRACT_CHANGED": [
    "apartment",
    "apartment_area",
    "client_name",
    "contract_number",
    "contract_total",
    "currency"
  ],
  "CONTRACT_CREATED": [
    "apartment",
    "client_name",
    "contract_number"
  ],
  "CONTRACT_PAID": [
    "client_name",
    "contract_number"
  ],
  "CONTRACT_TERMINATED": [
    "client_name",
    "contract_number"
  ],
  "DEAL_INFO": [
    "apartment",
    "apartment_area",
    "client_name",
    "contract_number",
    "contract_total",
    "currency",
    "remaining_balance",
    "total_paid"
  ],
  "DEBTOR_REMINDER": [
    "client_name",
    "contract_number",
    "currency",
    "overdue_amount"
  ],
  "MEETING_REMINDER": [
    "client_name",
    "meeting_date",
    "meeting_time"
  ],
  "PAYMENT_CANCELLED": [
    "client_name",
    "contract_number"
  ],
  "PAYMENT_RECEIVED": [
    "client_name",
    "contract_currency",
    "contract_number",
    "payment_amount",
    "payment_currency",
    "remaining_balance",
    "total_paid"
  ],
  "PAYMENT_REMINDER": [
    "client_name",
    "contract_number",
    "currency",
    "payment_amount",
    "payment_date"
  ],
  "RESERVATION_CANCELLED": [
    "apartment",
    "client_name"
  ],
  "RESERVATION_CREATED": [
    "apartment",
    "client_name"
  ],
  "RESERVATION_EXPIRING": [
    "apartment",
    "client_name"
  ],
  "SCHEDULE_CHANGED": [
    "client_name",
    "contract_number"
  ]
};

test('all Tajik translations retain exactly the same variable names as Russian canonical templates', () => {
  assert.deepEqual(Object.keys(TAJIK_SMS_TEMPLATES).sort(), Object.keys(CANONICAL_PLACEHOLDERS).sort());
  for (const [code, expected] of Object.entries(CANONICAL_PLACEHOLDERS)) {
    const actual = [...new Set([...TAJIK_SMS_TEMPLATES[code].matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]))].sort();
    assert.deepEqual(actual, expected, 'Placeholder mismatch: ' + code);
  }
});
