import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');

const PSQL_PATH = process.env.PSQL_PATH || 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
const PG_HOST = process.env.PGHOST || 'localhost';
const PG_PORT = process.env.PGPORT || '5432';
const PG_USER = process.env.PGUSER || 'postgres';
const PG_PASSWORD = process.env.PGPASSWORD || 'postgres';
const TEST_DB = 'tozon_057_pg_test';

function runPsql(sql, database = TEST_DB) {
  return new Promise((resolve) => {
    const child = spawn(
      PSQL_PATH,
      ['-h', PG_HOST, '-p', PG_PORT, '-U', PG_USER, '-d', database, '-X', '-v', 'ON_ERROR_STOP=1', '-t', '-A'],
      { env: { ...process.env, PGPASSWORD: PG_PASSWORD } }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

async function runPsqlFile(filePath, database = TEST_DB) {
  const { stdout, stderr } = await execFileAsync(
    PSQL_PATH,
    ['-h', PG_HOST, '-p', PG_PORT, '-U', PG_USER, '-d', database, '-X', '-v', 'ON_ERROR_STOP=1', '-f', filePath],
    { env: { ...process.env, PGPASSWORD: PG_PASSWORD }, maxBuffer: 10 * 1024 * 1024 }
  );
  return { stdout, stderr };
}

const hasLocalPostgres = fs.existsSync(PSQL_PATH);

describe.skipIf(!hasLocalPostgres)(
  'Real PostgreSQL 16 Integration & Multi-Connection Concurrency — Migration 057',
  () => {
    it('verifies immutable RKO history, global RKO uniqueness, accounting/DDS consistency, sequential replacements, real concurrent locks & rollback', async () => {
      // Recreate isolated test database
      const dropRes = await runPsql(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`, 'postgres');
      expect(dropRes.ok).toBe(true);
      const createRes = await runPsql(`CREATE DATABASE ${TEST_DB};`, 'postgres');
      expect(createRes.ok).toBe(true);

      try {
        // 1. Setup base schema mirroring production tables
        const setupRes = await runPsql(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
          END $$;

          CREATE TABLE public.users (id BIGSERIAL PRIMARY KEY, name TEXT, role TEXT);
          CREATE TABLE public.dictionaries (
            id TEXT PRIMARY KEY, type TEXT, code TEXT, name TEXT,
            is_active BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE TABLE public.cash_desks (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            opening_balance_minor BIGINT NOT NULL DEFAULT 0
          );
          CREATE TABLE public.deals (
            id BIGSERIAL PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'SIGNED',
            cancelled_at TIMESTAMPTZ,
            final_price_minor BIGINT NOT NULL DEFAULT 10000000,
            barter_amount_minor BIGINT NOT NULL DEFAULT 0,
            refund_amount_minor BIGINT NOT NULL DEFAULT 0
          );
          CREATE TABLE public.payments (
            id BIGSERIAL PRIMARY KEY,
            deal_id BIGINT NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
            cash_desk_id BIGINT NOT NULL DEFAULT 1 REFERENCES public.cash_desks(id),
            amount_minor BIGINT NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'USD',
            status TEXT NOT NULL DEFAULT 'ACTIVE',
            voided_at TIMESTAMPTZ,
            settlement_method TEXT DEFAULT 'CASH',
            method TEXT DEFAULT 'CASH'
          );
          CREATE TABLE public.deal_audit_logs (
            id BIGSERIAL PRIMARY KEY,
            deal_id BIGINT NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
            user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
            action TEXT NOT NULL,
            changes_json JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE TABLE public.expenses (
            id BIGSERIAL PRIMARY KEY,
            cash_desk_id BIGINT NOT NULL DEFAULT 1 REFERENCES public.cash_desks(id),
            reference TEXT,
            recipient TEXT,
            amount_minor BIGINT NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USD',
            settlement_method TEXT DEFAULT 'CASH',
            status TEXT NOT NULL DEFAULT 'ACTIVE',
            void_reason TEXT,
            voided_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
            voided_at TIMESTAMPTZ
          );

          INSERT INTO public.users (id, name, role) VALUES (1, 'Admin', 'ADMIN'), (3, 'Fin', 'FINANCE_MANAGER');
          INSERT INTO public.cash_desks (id, name, opening_balance_minor) VALUES (1, 'Основная касса', 1000000);
          INSERT INTO public.deals (id, status, final_price_minor) VALUES
            (101, 'SIGNED', 10000000),
            (102, 'SIGNED', 10000000),
            (103, 'SIGNED', 10000000),
            (104, 'SIGNED', 10000000);
          INSERT INTO public.payments (id, deal_id, cash_desk_id, amount_minor, status, settlement_method) VALUES
            (1, 101, 1, 1200000, 'ACTIVE', 'CASH'), -- 3% -> 300,000
            (2, 102, 1, 1200000, 'ACTIVE', 'CASH'), -- 3% -> 300,000
            (3, 103, 1, 1200000, 'ACTIVE', 'CASH'), -- 3% -> 300,000
            (4, 104, 1, 1200000, 'ACTIVE', 'CASH'); -- 3% -> 300,000
        `);
        expect(setupRes.ok).toBe(true);

        await runPsqlFile(path.join(migrationsDir, '055_sales_sources_and_marketing_commissions.sql'));
        const partnerRes = await runPsql(`
          INSERT INTO public.marketing_partners (id, name, commission_type, commission_rate_bp)
          VALUES (701, 'Somon Agency', 'PERCENT', 300);
          UPDATE public.deals SET sales_source = 'MARKETER', marketing_partner_id = 701 WHERE id IN (101, 102, 103, 104);
        `);
        expect(partnerRes.ok).toBe(true);

        await runPsqlFile(path.join(migrationsDir, '057_marketing_commission_atomic_ops_and_rko_guard.sql'));

        // Seed RKOs
        const rkoSeedRes = await runPsql(`
          INSERT INTO public.expenses (id, cash_desk_id, reference, recipient, amount_minor, status) VALUES
            (10, 1, 'РКО-010', 'Somon Agency', 300000, 'ACTIVE'),
            (11, 1, 'РКО-011', 'Somon Agency', 300000, 'ACTIVE'),
            (12, 1, 'РКО-012', 'Somon Agency', 300000, 'ACTIVE'),
            (13, 1, 'РКО-013', 'Somon Agency', 300000, 'ACTIVE'),
            (20, 1, 'РКО-020', 'Somon Agency', 100000, 'ACTIVE'),
            (21, 1, 'РКО-021', 'Somon Agency', 100000, 'ACTIVE'),
            (22, 1, 'РКО-022', 'Somon Agency', 100000, 'ACTIVE'),
            (23, 1, 'РКО-023', 'Somon Agency', 100000, 'ACTIVE'),
            (30, 1, 'РКО-030', 'Somon Agency', 300000, 'ACTIVE'),
            (31, 1, 'РКО-031', 'Somon Agency', 300000, 'ACTIVE'),
            (40, 1, 'РКО-040', 'Somon Agency', 100000, 'ACTIVE');
        `);
        expect(rkoSeedRes.ok).toBe(true);

        // =====================================================================
        // A. Full Accounting & DDS Scenario + Sequential Voiding (3 replacements)
        // =====================================================================
        expect((await runPsql(`SELECT public.approve_marketing_commission_atomic(101, 1, 'pg-app-101', 'Approve 101');`)).ok).toBe(true);
        expect((await runPsql(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 10, 'Somon Agency', 'pg-pay-101-10', 'Первая выплата');`)).ok).toBe(true);

        const cashQuery = `
          SELECT (
            (SELECT opening_balance_minor FROM public.cash_desks WHERE id = 1)
            + COALESCE((SELECT SUM(amount_minor) FROM public.payments WHERE cash_desk_id = 1 AND voided_at IS NULL AND status NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')), 0)
            - COALESCE((SELECT SUM(amount_minor) FROM public.expenses WHERE cash_desk_id = 1 AND voided_at IS NULL AND status NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')), 0)
          )::BIGINT;
        `;
        const ddsDeal101Query = `
          SELECT COALESCE(SUM(amount_minor), 0)::BIGINT || '|' || COUNT(*)::INT
          FROM public.expenses
          WHERE id IN (10, 11, 12, 13)
            AND voided_at IS NULL
            AND status NOT IN ('VOIDED', 'CANCELLED', 'REVERSED');
        `;

        // Before void: 10, 11, 12, 13, 20..23, 30, 31, 40 are all seeded ACTIVE; check relative delta for deal 101 RKOs
        expect((await runPsql(ddsDeal101Query)).stdout).toBe('1200000|4');
        const cashBaselineBeforeVoid = Number((await runPsql(cashQuery)).stdout);

        // Void initial RKO 10 -> cash increases by +300000, paid_amount_minor preserved at 300000
        expect((await runPsql(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW(), voided_by = 1, void_reason = 'Ошибка даты' WHERE id = 10;`)).ok).toBe(true);
        expect(Number((await runPsql(cashQuery)).stdout)).toBe(cashBaselineBeforeVoid + 300000);
        expect((await runPsql(`SELECT status || '|' || paid_amount_minor FROM public.marketing_commissions WHERE deal_id = 101;`)).stdout).toBe('RECONCILIATION_REQUIRED|300000');

        // Reconcile with RKO 11 -> NO extra expense, NO extra cash deduction, paid_amount_minor stays 300000
        const op101Id = Number((await runPsql(`SELECT id FROM public.marketing_commission_operations WHERE deal_id = 101 AND action_type = 'RECORD_PAYOUT';`)).stdout);
        expect((await runPsql(`SELECT public.reconcile_marketing_commission_payout_with_rko_atomic(101, 1, ${op101Id}, 11, 'Somon Agency', 'pg-rec-101-11', 'Замена №1 на РКО-011');`)).ok).toBe(true);
        expect(Number((await runPsql(cashQuery)).stdout)).toBe(cashBaselineBeforeVoid + 300000);
        expect((await runPsql(`SELECT status || '|' || paid_amount_minor FROM public.marketing_commissions WHERE deal_id = 101;`)).stdout).toBe('PAID|300000');

        // Sequential void #2 (void replacement RKO 11) -> reconcile with RKO 12
        expect((await runPsql(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW(), voided_by = 3, void_reason = 'Ошибка кассы' WHERE id = 11;`)).ok).toBe(true);
        expect((await runPsql(`SELECT public.reconcile_marketing_commission_payout_with_rko_atomic(101, 1, ${op101Id}, 12, 'Somon Agency', 'pg-rec-101-12', 'Замена №2 на РКО-012');`)).ok).toBe(true);

        // Sequential void #3 (void replacement RKO 12) -> reconcile with RKO 13
        expect((await runPsql(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW(), voided_by = 1, void_reason = 'Ошибка суммы в печати' WHERE id = 12;`)).ok).toBe(true);
        expect((await runPsql(`SELECT public.reconcile_marketing_commission_payout_with_rko_atomic(101, 1, ${op101Id}, 13, 'Somon Agency', 'pg-rec-101-13', 'Замена №3 на РКО-013');`)).ok).toBe(true);

        // Verify DDS has ONLY 1 active RKO (13) of 300,000, and paid_amount_minor = 300,000 (not 600k/900k/1.2M!)
        expect((await runPsql(ddsDeal101Query)).stdout).toBe('300000|1');
        expect((await runPsql(`SELECT status || '|' || paid_amount_minor FROM public.marketing_commissions WHERE deal_id = 101;`)).stdout).toBe('PAID|300000');

        // Verify full 7-event immutable history (1 -> void 10 -> 11 -> void 11 -> 12 -> void 12 -> 13)
        const hist101 = await runPsql(`
          SELECT sequence_no || ':' || event_type || ':' || rko_expense_id || ':' || COALESCE(previous_rko_expense_id::TEXT, 'NULL') || ':' || status
          FROM public.marketing_commission_rko_history
          WHERE payout_operation_id = ${op101Id}
          ORDER BY sequence_no ASC;
        `);
        expect(hist101.stdout.split(/\r?\n/)).toEqual([
          '1:INITIAL_PAYOUT:10:NULL:ACTIVE',
          '2:RKO_VOIDED:10:NULL:VOIDED_RECONCILIATION_REQUIRED',
          '3:REPLACEMENT_RKO:11:10:ACTIVE',
          '4:RKO_VOIDED:11:NULL:VOIDED_RECONCILIATION_REQUIRED',
          '5:REPLACEMENT_RKO:12:11:ACTIVE',
          '6:RKO_VOIDED:12:NULL:VOIDED_RECONCILIATION_REQUIRED',
          '7:REPLACEMENT_RKO:13:12:ACTIVE',
        ]);

        // Verify immutability of marketing_commission_rko_history
        const updHist = await runPsql(`UPDATE public.marketing_commission_rko_history SET reason = 'hack' WHERE payout_operation_id = ${op101Id};`);
        expect(updHist.ok).toBe(false);
        expect(updHist.stderr).toMatch(/IMMUTABLE_RKO_HISTORY/);
        const delHist = await runPsql(`DELETE FROM public.marketing_commission_rko_history WHERE payout_operation_id = ${op101Id};`);
        expect(delHist.ok).toBe(false);
        expect(delHist.stderr).toMatch(/IMMUTABLE_RKO_HISTORY/);

        // Verify PostgreSQL-level uniqueness across initial and replacement RKOs (10, 11, 12, 13)
        for (const usedRkoId of [10, 11, 12, 13]) {
          const dupDirect = await runPsql(`
            INSERT INTO public.marketing_commission_rko_history
              (deal_id, payout_operation_id, sequence_no, event_type, rko_expense_id, rko_reference, status, reason)
            VALUES (101, ${op101Id}, ${100 + usedRkoId}, 'REPLACEMENT_RKO', ${usedRkoId}, 'РКО-DUP', 'ACTIVE', 'dup test');
          `);
          expect(dupDirect.ok).toBe(false);
          expect(dupDirect.stderr).toMatch(/idx_mkt_comm_rko_history_unique_rko_usage|duplicate key value violates unique constraint/);
        }

        // =====================================================================
        // B. Real Multi-Connection Concurrency Tests (PostgreSQL 16 TCP)
        // =====================================================================
        expect((await runPsql(`SELECT public.approve_marketing_commission_atomic(102, 1, 'pg-app-102', 'Approve 102');`)).ok).toBe(true);
        expect((await runPsql(`SELECT public.approve_marketing_commission_atomic(103, 1, 'pg-app-103', 'Approve 103');`)).ok).toBe(true);
        expect((await runPsql(`SELECT public.approve_marketing_commission_atomic(104, 1, 'pg-app-104', 'Approve 104');`)).ok).toBe(true);

        // B1. 5 parallel sessions with SAME idempotency_key on deal 102
        const sameKeyCalls = await Promise.all(
          Array.from({ length: 5 }, () =>
            runPsql(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 100000, 20, 'Somon Agency', 'pg-same-key-102', 'Parallel same key');`)
          )
        );
        for (const r of sameKeyCalls) {
          expect(r.ok).toBe(true);
          expect(r.stderr).not.toMatch(/deadlock detected|40P01/i);
        }
        expect((await runPsql(`SELECT paid_amount_minor FROM public.marketing_commissions WHERE deal_id = 102;`)).stdout).toBe('100000');

        // B2. 3 parallel sessions with DIFFERENT idempotency_keys competing for remaining 200,000 on deal 102 (RKOs 21, 22, 23 = 100k each -> max 2 can win)
        const diffKeyCalls = await Promise.all([
          runPsql(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 100000, 21, 'Somon Agency', 'pg-diff-21', 'Parallel 21');`),
          runPsql(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 100000, 22, 'Somon Agency', 'pg-diff-22', 'Parallel 22');`),
          runPsql(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 100000, 23, 'Somon Agency', 'pg-diff-23', 'Parallel 23');`),
        ]);
        for (const r of diffKeyCalls) {
          expect(r.stderr).not.toMatch(/deadlock detected|40P01/i);
        }
        expect(diffKeyCalls.filter((r) => r.ok).length).toBe(2);
        expect(diffKeyCalls.filter((r) => !r.ok).length).toBe(1);
        expect((await runPsql(`SELECT status || '|' || paid_amount_minor FROM public.marketing_commissions WHERE deal_id = 102;`)).stdout).toBe('PAID|300000');

        // B3. Parallel payout vs voiding the same RKO 30 on deal 103 (canonical lock order test)
        const [pay30, void30] = await Promise.all([
          runPsql(`SELECT public.record_marketing_commission_payout_atomic(103, 3, 300000, 30, 'Somon Agency', 'pg-race-30', 'Race pay 30');`),
          runPsql(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW(), voided_by = 1, void_reason = 'Race void 30' WHERE id = 30;`),
        ]);
        expect(pay30.stderr).not.toMatch(/deadlock detected|40P01/i);
        expect(void30.stderr).not.toMatch(/deadlock detected|40P01/i);
        expect(void30.ok).toBe(true);
        if (pay30.ok) {
          // If payout committed first, void trigger MUST have marked deal 103 RECONCILIATION_REQUIRED
          expect((await runPsql(`SELECT status FROM public.marketing_commissions WHERE deal_id = 103;`)).stdout).toBe('RECONCILIATION_REQUIRED');
        } else {
          expect(pay30.stderr).toMatch(/RKO_VOIDED/);
        }

        // B4. Parallel reconcile race: 2 sessions trying to use the same RKO 31 on deal 104 + concurrent partial refunds
        expect((await runPsql(`SELECT public.record_marketing_commission_payout_atomic(104, 3, 300000, 31, 'Somon Agency', 'pg-pay-104-31', 'Pay 104');`)).ok).toBe(true);
        expect((await runPsql(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW(), voided_by = 1, void_reason = 'Void 31' WHERE id = 31;`)).ok).toBe(true);
        const op104Id = Number((await runPsql(`SELECT id FROM public.marketing_commission_operations WHERE deal_id = 104 AND action_type = 'RECORD_PAYOUT';`)).stdout);

        const [recA, recB] = await Promise.all([
          runPsql(`SELECT public.reconcile_marketing_commission_payout_with_rko_atomic(104, 1, ${op104Id}, 31, 'Somon Agency', 'pg-rec-race-a', 'Race A');`),
          runPsql(`SELECT public.reconcile_marketing_commission_payout_with_rko_atomic(104, 1, ${op104Id}, 31, 'Somon Agency', 'pg-rec-race-b', 'Race B');`),
        ]);
        expect(recA.stderr).not.toMatch(/deadlock detected|40P01/i);
        expect(recB.stderr).not.toMatch(/deadlock detected|40P01/i);
        expect(recA.ok).toBe(false);
        expect(recB.ok).toBe(false);

        // Concurrent partial refunds on deal 104 (3 parallel 100k refunds = 300k total -> all 3 succeed, 4th fails)
        const [ref1, ref2, ref3, ref4] = await Promise.all([
          runPsql(`SELECT public.confirm_marketing_commission_payout_refund_atomic(104, 1, ${op104Id}, 100000, 'ПКО-PG-1', 'pg-ref-1', 'Часть 1');`),
          runPsql(`SELECT public.confirm_marketing_commission_payout_refund_atomic(104, 1, ${op104Id}, 100000, 'ПКО-PG-2', 'pg-ref-2', 'Часть 2');`),
          runPsql(`SELECT public.confirm_marketing_commission_payout_refund_atomic(104, 1, ${op104Id}, 100000, 'ПКО-PG-3', 'pg-ref-3', 'Часть 3');`),
          runPsql(`SELECT public.confirm_marketing_commission_payout_refund_atomic(104, 1, ${op104Id}, 100000, 'ПКО-PG-4', 'pg-ref-4', 'Лишняя 4');`),
        ]);
        const refAll = [ref1, ref2, ref3, ref4];
        for (const r of refAll) {
          expect(r.stderr).not.toMatch(/deadlock detected|40P01/i);
        }
        expect(refAll.filter((r) => r.ok).length).toBe(3);
        expect(refAll.filter((r) => !r.ok).length).toBe(1);
        expect((await runPsql(`SELECT status || '|' || paid_amount_minor FROM public.marketing_commissions WHERE deal_id = 104;`)).stdout).toBe('APPROVED|0');

        // =====================================================================
        // C. Verify Clean Rollback on Real PostgreSQL 16
        // =====================================================================
        await runPsql(`UPDATE public.marketing_commissions SET status = 'PAID', reconciliation_required = FALSE WHERE status = 'RECONCILIATION_REQUIRED';`);
        await runPsqlFile(path.join(migrationsDir, 'rollback_057_marketing_commission_atomic_ops_and_rko_guard.sql'));
        expect((await runPsql(`SELECT COALESCE(to_regclass('public.marketing_commission_rko_history')::TEXT, 'NULL');`)).stdout).toBe('NULL');
        expect((await runPsql(`SELECT COALESCE(to_regclass('public.marketing_commission_operations')::TEXT, 'NULL');`)).stdout).toBe('NULL');
      } finally {
        await runPsql(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`, 'postgres');
      }
    }, 60000);
  }
);
