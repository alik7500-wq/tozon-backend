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
