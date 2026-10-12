import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildReport, renderReport, localDay, validDay, periodFor, dailyDue, splitMessage } from './report.js';
import { FinanceBot, TelegramAPI, keyboard } from './bot.js';

const now = new Date('2026-10-11T17:00:00Z');
const payment = overrides => ({ id: 1, currency: 'USD', amount_minor: 10000, payment_date: '2026-10-11', settlement_method: 'CASH', status: 'ACTIVE', cash_desk_id: 'a', ...overrides });
const expense = overrides => ({ id: 1, currency: 'USD', amount_minor: 2000, expense_date: '2026-10-11', settlement_method: 'CASH', status: 'ACTIVE', cash_desk_id: 'a', ...overrides });
const snapshot = overrides => ({ desks: [{ id: 'a', name: 'Касса А' }, { id: 'b', name: 'Касса Б' }], payments: [], expenses: [], deals: [], ...overrides });
const approved = { telegram_id: '12345', status: 'APPROVED', slot: 'ILHOM' };
function setup(user = approved) {
  const seen = new Set();
  const repo = { find: vi.fn(async () => user), register: vi.fn(), snapshot: vi.fn(async () => snapshot()), subscribers: vi.fn(async () => [user]), beginDelivery: vi.fn(async (id, date) => { const key = `${id}:${date}`; if (seen.has(key)) return null; seen.add(key); return {}; }), finishDelivery: vi.fn(), claimLease: vi.fn(async () => true), state: vi.fn(async () => ({ update_offset: 0 })), offset: vi.fn() };
  repo.pending = vi.fn(async () => []); repo.updateStatus = vi.fn(); repo.deliveries = vi.fn(async () => []);
  const api = { send: vi.fn(), call: vi.fn(async () => []) };
  return { repo, api, bot: new FinanceBot(repo, api, { clock: () => now, logger: { warn: vi.fn() } }) };
}
const update = text => ({ update_id: 1, message: { from: { id: 12345, first_name: 'Test' }, chat: { id: 12345, type: 'private' }, text } });

describe('Finance report calculations', () => {
  it('uses Khujand dates across UTC midnight and schedules at exactly 22:00', () => {
    expect(localDay('2026-10-11T20:00:00Z')).toBe('2026-10-12');
    expect(dailyDue(new Date('2026-10-11T16:59:59Z'))).toBe(false);
    expect(dailyDue(now)).toBe(true);
    expect(dailyDue(new Date('2026-10-11T19:00:00Z'))).toBe(false);
    expect(periodFor('yesterday', new Date('2026-01-01T00:00Z'))).toEqual({ from: '2025-12-31', to: '2025-12-31' });
    expect(periodFor('month', now)).toEqual({ from: '2026-10-01', to: '2026-10-11' });
  });
  it('rejects invalid dates, reversed and future periods', () => {
    expect(validDay('2026-02-30')).toBe(false);
    expect(() => buildReport(snapshot(), '2026-10-12', '2026-10-12', now)).toThrow();
    expect(() => buildReport(snapshot(), '2026-10-11', '2026-10-10', now)).toThrow();
  });
  it('keeps currencies separate, reconciles opening and closing, excludes transfers from company totals', () => {
    const r = buildReport(snapshot({ payments: [payment({ payment_date: '2026-10-10', amount_minor: 10000 }), payment({ deal_id: 1 }), payment({ id: 2, cash_desk_id: 'b', transfer_id: 't', amount_minor: 3000 }), payment({ id: 3, currency: 'TJS', amount_minor: 200000 })], expenses: [expense(), expense({ id: 2, transfer_id: 't', amount_minor: 3000 })] }), '2026-10-11', '2026-10-11', now);
    expect(r.income).toEqual({ USD: 10000, TJS: 200000 });
    expect(r.customerIncome).toEqual({ USD: 10000 });
    expect(r.expense).toEqual({ USD: 2000 });
    expect(r.desks[0].opening).toEqual({ USD: 10000 });
    expect(r.desks[0].closing).toEqual({ USD: 15000, TJS: 200000 });
    expect(r.desks[1].closing).toEqual({ USD: 3000 });
  });
  it('excludes legacy and modern conversions from external totals while retaining cash movement', () => {
    const r = buildReport(snapshot({ payments: [payment({ settlement_method: 'CONVERSION' }), payment({ id: 2, reference: 'ПКО-ОБМЕН-1' })], expenses: [expense({ reference: 'КОНВ-1' }), expense({ id: 2, category: 'Внутренние перемещения между кассами' })] }), '2026-10-11', '2026-10-11', now);
    expect(r.income).toEqual({}); expect(r.expense).toEqual({}); expect(r.desks[0].closing).toEqual({ USD: 16000 });
  });
  it('excludes voided, reversed, cancelled, future and barter rows', () => {
    const r = buildReport(snapshot({ payments: [payment({ status: 'VOIDED' }), payment({ status: 'REVERSED' }), payment({ status: 'CANCELLED' }), payment({ voided_at: now.toISOString() }), payment({ settlement_method: 'NON_CASH_BARTER' }), payment({ id: 94, settlement_method: null }), payment({ payment_date: '2026-10-12' }), payment({ created_at: '2026-10-11T18:00Z' })] }), '2026-10-11', '2026-10-11', now);
    expect(r.income).toEqual({}); expect(r.desks[0].closing).toEqual({});
  });
  it('counts the TJS expense after USD conversion exactly once, without counting exchange legs', () => {
    const r = buildReport(snapshot({
      payments: [payment({ currency: 'TJS', amount_minor: 92700, conversion_id: 'conversion-1', reference: 'ПКО-КОНВ-1' })],
      expenses: [
        expense({ amount_minor: 10000, conversion_id: 'conversion-1', category: 'Конвертация валюты', reference: 'КОНВ-1' }),
        expense({ id: 2, currency: 'TJS', amount_minor: 92700, conversion_id: 'conversion-1', conversion_expense_id: 1, category: 'Строительные материалы', reference: 'РКО-2' }),
      ],
    }), '2026-10-11', '2026-10-11', now);
    expect(r.expense).toEqual({ TJS: 92700 });
    expect(r.income).toEqual({});
    expect(r.details).toHaveLength(1);
    expect(r.desks[0].closing).toEqual({ USD: -10000, TJS: 0 });
    expect(renderReport(r)).toContain('927,00 TJS');
  });
  it('retains expenses with either conversion linkage field and still rejects cancelled linked expenses', () => {
    const r = buildReport(snapshot({ expenses: [
      expense({ conversion_id: 'group', amount_minor: 10000 }),
      expense({ id: 2, conversion_expense_id: 1, amount_minor: 5000 }),
      expense({ id: 3, conversion_id: 'group', conversion_expense_id: 1, status: 'VOIDED', amount_minor: 99999 }),
    ] }), '2026-10-11', '2026-10-11', now);
    expect(r.expense).toEqual({ USD: 15000 });
    expect(r.details).toHaveLength(2);
  });
  it('counts bank receipts in movement but not cash', () => {
    const r = buildReport(snapshot({ payments: [payment({ settlement_method: 'BANK', deal_id: 7 })] }), '2026-10-11', '2026-10-11', now);
    expect(r.income.USD).toBe(10000); expect(r.desks[0].closing).toEqual({});
  });
  it('counts sales by signed date and preserves TJS contracts', () => {
    const r = buildReport(snapshot({ deals: [{ status: 'SIGNED', deal_date: '2026-10-01', signed_at: '2026-10-10T20:00Z', currency: 'TJS', final_price_minor: 2000000, area_m2_x100: 6500 }, { status: 'CANCELLED', deal_date: '2026-10-11' }] }), '2026-10-11', '2026-10-11', now);
    expect(r.salesCount).toBe(1); expect(r.sales).toEqual({ TJS: 2000000 }); expect(r.area).toBe(6500);
  });
  it('flags unmapped cash instead of assigning another cashier', () => {
    const r = buildReport(snapshot({ payments: [payment({ cash_desk_id: null })] }), '2026-10-11', '2026-10-11', now);
    expect(r.desks.at(-1).name).toContain('требуется сверка');
  });
  it('does not reveal expense descriptions to partners; owner can view details', () => {
    const r = buildReport(snapshot({ expenses: [expense({ description: 'PRIVATE DETAILS' })] }), '2026-10-11', '2026-10-11', now);
    expect(renderReport(r)).not.toContain('PRIVATE DETAILS');
    expect(() => renderReport(r, 'details', 'PARTNER')).toThrow('DETAILS_FORBIDDEN');
    expect(renderReport(r, 'details', 'OWNER')).toContain('PRIVATE DETAILS');
    expect(JSON.stringify(keyboard('PARTNER'))).not.toContain('details');
  });
  it('splits long reports below Telegram message limits', () => {
    const parts = splitMessage('a'.repeat(9000) + '\n' + 'b'.repeat(1000));
    expect(parts.every(p => p.length <= 3500)).toBe(true);
  });
});

describe('Telegram access and reliable dispatch', () => {
  it('registers start requests but never grants access by name', async () => {
    const { bot, api, repo } = setup({ ...approved, status: 'PENDING', slot: null });
    await bot.handle(update('/start'));
    expect(repo.register).toHaveBeenCalled(); expect(repo.snapshot).not.toHaveBeenCalled(); expect(api.send.mock.calls[0][1]).toContain('закрыт');
  });
  it('rejects group chats and chat/user identity mismatches', async () => {
    const { bot, api } = setup(); const u = update('/today'); u.message.chat.type = 'group'; await bot.handle(u); u.message.chat.type = 'private'; u.message.chat.id = 99; await bot.handle(u); expect(api.send).not.toHaveBeenCalled();
  });
  it('checks authorization for forged detailed callbacks', async () => {
    const { bot, api, repo } = setup(); const u = update('/today'); await bot.handle({ callback_query: { id: 'cb', from: u.message.from, message: u.message, data: 'details:today' } }); expect(repo.snapshot).not.toHaveBeenCalled(); expect(api.send.mock.calls[0][1]).toContain('итоговая');
  });
  it('does not send a report when access was revoked during generation', async () => {
    const { bot, api, repo } = setup(); repo.find.mockResolvedValueOnce(approved).mockResolvedValueOnce({ ...approved, status: 'REVOKED' }); await bot.report(approved); expect(api.send).not.toHaveBeenCalled();
  });
  it('supports date ranges and rejects future periods without fetching finance', async () => {
    const { bot, repo } = setup(); await bot.handle(update('/report 2026-10-01 2026-10-11')); expect(repo.snapshot).toHaveBeenCalledOnce();
    const s = setup(); await s.bot.handle(update('/report 2026-10-12')); expect(s.repo.snapshot).not.toHaveBeenCalled();
  });
  it('claims daily deliveries once, even on repeated scheduling', async () => {
    const { bot, api, repo } = setup(); await bot.daily(); await bot.daily(); expect(api.send).toHaveBeenCalledOnce(); expect(repo.finishDelivery).toHaveBeenCalledWith('12345', '2026-10-11', 'SENT');
  });
  it('does not resend ambiguous Telegram delivery failures', async () => {
    const { bot, api, repo } = setup(); api.send.mockRejectedValue(new Error('timeout')); await bot.daily(); await bot.daily(); expect(api.send).toHaveBeenCalledOnce(); expect(repo.finishDelivery).toHaveBeenCalledWith('12345', '2026-10-11', 'UNKNOWN');
  });
  it('does not poll when another replica holds the worker lease', async () => {
    const { bot, api, repo } = setup(); repo.claimLease.mockResolvedValue(false); await bot.tick(); expect(api.call).not.toHaveBeenCalled();
  });
  it('redacts the token even when fetch throws a URL-bearing exception', async () => {
    const api = new TelegramAPI('SECRET_TOKEN', async () => { throw new Error('https://api.telegram.org/botSECRET_TOKEN'); }); await expect(api.call('getMe')).rejects.toThrow('TELEGRAM_REQUEST_FAILED');
  });
});

describe('Database controls (isolated PGlite)', () => {
  it('locks down tables/RPCs, supplies untruncated snapshots, leases one worker and deduplicates delivery', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE TABLE payments (id int,deal_id int,amount_minor int,currency text,payment_date text,settlement_method text,reference text,comment text,created_at text,status text,voided_at timestamptz,transfer_id uuid,conversion_id uuid,cash_desk_id uuid,operation_type text);
        CREATE TABLE expenses (id int,amount_minor int,currency text,expense_date date,settlement_method text,reference text,category text,description text,created_at timestamptz,status text,voided_at timestamptz,transfer_id uuid,conversion_id uuid,conversion_expense_id int,cash_desk_id uuid,operation_type text);
        CREATE TABLE deals (id int,status text,currency text,final_price_minor int,signed_at text,deal_date text,created_at text,unit_id int);
        CREATE TABLE units (id int,area_m2_x100 int);
        CREATE TABLE dictionaries (id uuid,name text,code text,type text,is_active boolean,sort_order int);
        GRANT SELECT ON payments, expenses, deals, units, dictionaries TO service_role;`);
      await db.exec(readFileSync(new URL('../../../supabase/migrations/20261011191647_telegram_finance_reports.sql', import.meta.url), 'utf8'));
      const grants = await db.query(`select has_table_privilege('anon','telegram_finance_subscribers','SELECT') a, has_table_privilege('authenticated','telegram_finance_state','UPDATE') b, has_function_privilege('anon','telegram_finance_snapshot()','EXECUTE') c, has_function_privilege('service_role','telegram_finance_snapshot()','EXECUTE') d`);
      expect(grants.rows[0]).toEqual({ a: false, b: false, c: false, d: true });
      await db.exec(`INSERT INTO payments(id,amount_minor) SELECT n,100 FROM generate_series(1,1005) n; SET ROLE service_role;`);
      const result = await db.query('select jsonb_array_length(telegram_finance_snapshot()->\'payments\') n'); expect(result.rows[0].n).toBe(1005);
      const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
      expect((await db.query('select telegram_finance_claim_worker($1) ok', [a])).rows[0].ok).toBe(true);
      expect((await db.query('select telegram_finance_claim_worker($1) ok', [b])).rows[0].ok).toBe(false);
      expect((await db.query('select telegram_finance_claim_worker($1) ok', [a])).rows[0].ok).toBe(true);
      await db.exec(`INSERT INTO telegram_finance_subscribers(telegram_id,slot,status) VALUES ('12345','ILHOM','APPROVED'); INSERT INTO telegram_finance_deliveries(telegram_id,report_date,status) VALUES ('12345','2026-10-11','PROCESSING');`);
      await expect(db.exec(`INSERT INTO telegram_finance_deliveries(telegram_id,report_date,status) VALUES ('12345','2026-10-11','PROCESSING')`)).rejects.toThrow();
      await expect(db.exec(`INSERT INTO telegram_finance_subscribers(telegram_id,slot,status) VALUES ('67890','ILHOM','APPROVED')`)).rejects.toThrow();
    } finally { await db.close(); }
  });
});
