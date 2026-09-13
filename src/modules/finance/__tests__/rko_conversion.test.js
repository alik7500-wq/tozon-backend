import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

import { connectDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';

describe('RKO Auto-Conversion & Exchange Fields Tests', () => {
  let db;
  const createdExpenseIds = [];
  const createdPaymentIds = [];

  beforeAll(() => {
    connectDB();
    db = createClient(supabaseUrl, supabaseKey);
  });

  afterAll(async () => {
    // Clean up created test entities
    if (createdExpenseIds.length > 0) {
      await db.from('expenses').delete().in('id', createdExpenseIds);
    }
    if (createdPaymentIds.length > 0) {
      await db.from('payments').delete().in('id', createdPaymentIds);
    }
  });

  it('1. Creates new TJS expense (14 000 TJS) with auto-conversion and saves exchange_rate, amount_usd, conversion_expense_id', async () => {
    const testReference = `РКО-VITEST-${Date.now().toString().slice(-4)}`;
    const newExpResult = await FinanceRepository.addExpense({
      amount: 14000,
      currency: 'TJS',
      source_currency: 'USD',
      auto_convert: true,
      exchange_rate: 9.27,
      category: 'Строительные материалы',
      recipient: 'Тестовый Поставщик',
      description: 'Тестовая закупка для проверки автоконвертации',
      reference: testReference,
      method: 'CASH',
      cash_desk_id: 'ab90800a-73af-4cf7-88c2-397c304e2edf',
      date: new Date().toISOString().split('T')[0]
    }, 1);

    expect(newExpResult).toBeDefined();
    expect(newExpResult.id).toBeDefined();
    createdExpenseIds.push(newExpResult.id);

    expect(Number(newExpResult.exchange_rate)).toBe(9.27);
    expect(Number(newExpResult.amount_usd)).toBe(1510.25);
    expect(newExpResult.conversion_expense_id).toBeDefined();
    expect(newExpResult.conversion_expense_id).not.toBeNull();

    createdExpenseIds.push(newExpResult.conversion_expense_id);

    // Track conversion payment for cleanup
    const { data: convPayments } = await db.from('payments')
      .select('id')
      .like('reference', 'ПКО-КОНВ-%')
      .order('id', { ascending: false })
      .limit(1);
    if (convPayments?.[0]?.id) {
      createdPaymentIds.push(convPayments[0].id);
    }
  });

  it('2. GET expenses returns exchange_rate, amount_usd, and conversion_expense_id', async () => {
    const expensesList = await FinanceRepository.getExpenses();
    expect(expensesList).toBeDefined();
    expect(expensesList.list).toBeInstanceOf(Array);

    const testItem = expensesList.list.find(e => createdExpenseIds.includes(e.id) && e.exchange_rate === 9.27);
    expect(testItem).toBeDefined();
    expect(testItem.exchange_rate).toBe(9.27);
    expect(testItem.amount_usd).toBe(1510.25);
    expect(testItem.conversion_expense_id).toBeDefined();
  });

  it('3. GET cashflow returns exchange_rate, amount_usd, and conversion_expense_id', async () => {
    const cashflow = await FinanceRepository.getCashflow();
    expect(cashflow).toBeDefined();
    expect(cashflow.transactions).toBeInstanceOf(Array);

    // cashflow transaction IDs are "exp-{id}" strings; use rawId to match
    const conversionExpId = createdExpenseIds.find(id => typeof id === 'number' && id !== createdExpenseIds[0]);
    const mainExpId = createdExpenseIds[0];

    // Look for the main TJS expense (type EXPENSE, exchange_rate 9.27)
    const testTx = cashflow.transactions.find(
      t => (t.rawId === mainExpId) && t.exchange_rate === 9.27
    );
    expect(testTx).toBeDefined();
    expect(testTx.exchange_rate).toBe(9.27);
    expect(testTx.amount_usd).toBe(1510.25);
    expect(testTx.conversion_expense_id).toBeDefined();
  });

  it('4. Regular expense without auto-conversion saves null exchange fields without regression', async () => {
    const regReference = `РКО-REG-${Date.now().toString().slice(-4)}`;
    const regResult = await FinanceRepository.addExpense({
      amount: 250,
      currency: 'USD',
      source_currency: 'USD',
      auto_convert: false,
      category: 'Офис',
      recipient: 'Тест',
      description: 'Без конвертации',
      reference: regReference,
      method: 'CASH',
      cash_desk_id: 'ab90800a-73af-4cf7-88c2-397c304e2edf',
      date: new Date().toISOString().split('T')[0]
    }, 1);

    expect(regResult).toBeDefined();
    createdExpenseIds.push(regResult.id);

    expect(regResult.exchange_rate).toBeNull();
    expect(regResult.amount_usd).toBeNull();
    expect(regResult.conversion_expense_id).toBeNull();
  });

  it('5. Historical РКО-921220 (id=143) and РКО-385704 (id=145) have valid snapshots', async () => {
    const { data: hist } = await db.from('expenses')
      .select('id, reference, exchange_rate, amount_usd, conversion_expense_id')
      .in('id', [143, 145]);

    const exp143 = hist.find(e => e.id === 143);
    const exp145 = hist.find(e => e.id === 145);

    expect(exp143).toBeDefined();
    expect(Number(exp143.exchange_rate)).toBe(9.27);
    expect(Number(exp143.amount_usd)).toBe(1510.25);

    expect(exp145).toBeDefined();
    expect(Number(exp145.exchange_rate)).toBe(9.27);
    expect(Number(exp145.amount_usd)).toBe(64.72);
  });
});
