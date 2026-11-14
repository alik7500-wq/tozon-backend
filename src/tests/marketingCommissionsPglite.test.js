import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');

describe('PostgreSQL (PGlite) Migration 057 — Cumulative Partial Refunds, Replacement RKO Reconciliation & Unified Lock Order', () => {
  it('verifies security, partial/full refunds, replacement RKO reconciliation without duplicate cash movement, concurrent ops & rollback', async () => {
    const db = new PGlite();

    await db.exec(`
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
        amount_minor BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        voided_at TIMESTAMPTZ,
        settlement_method TEXT,
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
        reference TEXT,
        recipient TEXT,
        amount_minor BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        void_reason TEXT,
        voided_by BIGINT,
        voided_at TIMESTAMPTZ
      );

      INSERT INTO public.users (id, name, role) VALUES (1, 'Admin', 'ADMIN'), (3, 'Fin', 'FINANCE_MANAGER');
      INSERT INTO public.deals (id, status, final_price_minor) VALUES
        (101, 'SIGNED', 10000000),
        (102, 'SIGNED', 5000000),
        (103, 'SIGNED', 10000000);
      INSERT INTO public.payments (id, deal_id, amount_minor, status, settlement_method) VALUES
        (1, 101, 1200000, 'ACTIVE', 'CASH'),  -- 12% -> 3% (300,000)
        (2, 102, 600000, 'ACTIVE', 'CASH'),   -- 12% -> 3% (150,000)
        (3, 103, 400000, 'ACTIVE', 'CASH');   -- 4%  -> 0% (0)
    `);

    const sql055 = fs.readFileSync(path.join(migrationsDir, '055_sales_sources_and_marketing_commissions.sql'), 'utf8');
    await db.exec(sql055);

    await db.exec(`
      INSERT INTO public.marketing_partners (id, name, commission_type, commission_rate_bp)
      VALUES (701, 'Somon Agency', 'PERCENT', 300);
      UPDATE public.deals SET sales_source = 'MARKETER', marketing_partner_id = 701 WHERE id IN (101, 102, 103);
    `);

    const sql057 = fs.readFileSync(path.join(migrationsDir, '057_marketing_commission_atomic_ops_and_rko_guard.sql'), 'utf8');
    await db.exec(sql057);

    // 1. Verify RPC security & search_path across all 6 functions
    const procMeta = await db.query(`
      SELECT proname, prosecdef, proconfig,
             has_function_privilege('anon', oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('public', oid, 'EXECUTE') AS pub_exec,
             has_function_privilege('service_role', oid, 'EXECUTE') AS srv_exec
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN (
          'compute_marketing_commission_from_db',
          'approve_marketing_commission_atomic',
          'record_marketing_commission_payout_atomic',
          'confirm_marketing_commission_payout_refund_atomic',
          'reconcile_marketing_commission_payout_with_rko_atomic',
          'guard_void_rko_linked_commission'
        )
      ORDER BY proname
    `);
    expect(procMeta.rows).toHaveLength(6);
    for (const row of procMeta.rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toContain('search_path=public, pg_temp');
      expect(row.anon_exec).toBe(false);
      expect(row.auth_exec).toBe(false);
      expect(row.pub_exec).toBe(false);
      expect(row.srv_exec).toBe(true);
    }

    // Below-5% deal cannot be approved
    await expect(
      db.query(`SELECT public.approve_marketing_commission_atomic(103, 1, 'app-key-103', 'Too low')`)
    ).rejects.toThrow(/APPROVED_COMMISSION_MUST_BE_POSITIVE/);

    // Approve deal 101 (3% = 300,000 minor)
    const appRes = await db.query(
      `SELECT public.approve_marketing_commission_atomic(101, 1, 'app-key-101', 'Initial approval') AS res`
    );
    expect(appRes.rows[0].res.approved_amount_minor).toBe(300000);

    await db.exec(`
      INSERT INTO public.expenses (id, reference, recipient, amount_minor, status, voided_at) VALUES
        (10, 'РКО-10', 'Somon Agency', 300000, 'ACTIVE', NULL),
        (11, 'РКО-11', 'Wrong Agency', 300000, 'ACTIVE', NULL),
        (12, 'РКО-12', 'Somon Agency', 150000, 'ACTIVE', NULL),
        (14, 'РКО-14', 'Somon Agency', 300000, 'ACTIVE', NULL),
        (15, 'РКО-15', 'Somon Agency', 100000, 'ACTIVE', NULL),
        (16, 'РКО-16', 'Somon Agency', 150000, 'ACTIVE', NULL),
        (17, 'РКО-17', 'Somon Agency', 150000, 'ACTIVE', NULL);
    `);

    const initialExpenseCount = Number((await db.query(`SELECT count(*)::INT AS c FROM public.expenses`)).rows[0].c);
    const initialPaymentCount = Number((await db.query(`SELECT count(*)::INT AS c FROM public.payments`)).rows[0].c);

    // Mandatory DB partner check
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 11, '', 'pay-bad-rec', 'test')`)
    ).rejects.toThrow(/RKO_RECIPIENT_MISMATCH/);

    // Buyer refund ceiling
    await db.query(`UPDATE public.deals SET refund_amount_minor = 500000 WHERE id = 101`);
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 10, 'Somon Agency', 'pay-exceeds-calc', 'test')`)
    ).rejects.toThrow(/PAYOUT_EXCEEDS_CALCULATED/);
    await db.query(`UPDATE public.deals SET refund_amount_minor = 0 WHERE id = 101`);

    // Normal payout + concurrent same-key replay
    const [p1, p2] = await Promise.all([
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 10, 'Somon Agency', 'pay-101-k1', 'Payout 101') AS res`),
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 10, 'Somon Agency', 'pay-101-k1', 'Payout 101') AS res`),
    ]);
    expect([p1.rows[0].res.idempotent, p2.rows[0].res.idempotent].sort()).toEqual([false, true]);
    expect(p1.rows[0].res.paid_amount_minor).toBe(300000);

    // Void RKO 10 -> RECONCILIATION_REQUIRED, paid_amount_minor preserved at 300,000
    await db.query(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW() WHERE id = 10`);
    const opAfterVoid = await db.query(`SELECT id FROM public.marketing_commission_operations WHERE deal_id = 101 AND rko_expense_id = 10`);
    const payoutOpId = Number(opAfterVoid.rows[0].id);

    // Repeat payout blocked while RECONCILIATION_REQUIRED
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 14, 'Somon Agency', 'pay-101-repeat', 'Repeat')`)
    ).rejects.toThrow(/COMMISSION_RECONCILIATION_REQUIRED/);

    // Partial refund 1 (100,000 of 300,000) -> MUST NOT set REFUND_CONFIRMED yet!
    const part1 = await db.query(
      `SELECT public.confirm_marketing_commission_payout_refund_atomic(101, 1, $1, 100000, 'ПКО-ВОЗВРАТ-01-A', 'ref-part-1', 'Часть 1') AS res`,
      [payoutOpId]
    );
    expect(part1.rows[0].res.paid_amount_minor).toBe(200000);
    expect(part1.rows[0].res.operation_reconciliation_status).toBe('RECONCILIATION_REQUIRED');
    expect(part1.rows[0].res.status).toBe('RECONCILIATION_REQUIRED');
    expect(part1.rows[0].res.reconciliation_required).toBe(true);

    // Over-refund beyond remaining 200,000 is rejected
    await expect(
      db.query(
        `SELECT public.confirm_marketing_commission_payout_refund_atomic(101, 1, $1, 250000, 'ПКО-ВОЗВРАТ-OVER', 'ref-part-over', 'Перебор')`,
        [payoutOpId]
      )
    ).rejects.toThrow(/REFUND_EXCEEDS_PAID/);

    // Partial refund 2 (remaining 200,000) with concurrent same-key replay -> completes REFUND_CONFIRMED!
    const [part2a, part2b] = await Promise.all([
      db.query(
        `SELECT public.confirm_marketing_commission_payout_refund_atomic(101, 1, $1, 200000, 'ПКО-ВОЗВРАТ-01-B', 'ref-part-2', 'Часть 2') AS res`,
        [payoutOpId]
      ),
      db.query(
        `SELECT public.confirm_marketing_commission_payout_refund_atomic(101, 1, $1, 200000, 'ПКО-ВОЗВРАТ-01-B', 'ref-part-2', 'Часть 2') AS res`,
        [payoutOpId]
      ),
    ]);
    expect([part2a.rows[0].res.idempotent, part2b.rows[0].res.idempotent].sort()).toEqual([false, true]);
    expect(part2a.rows[0].res.paid_amount_minor).toBe(0);
    expect(part2a.rows[0].res.operation_reconciliation_status).toBe('REFUND_CONFIRMED');
    expect(part2a.rows[0].res.status).toBe('APPROVED');
    expect(part2a.rows[0].res.reconciliation_required).toBe(false);

    // Repeating refund on already REFUND_CONFIRMED operation is rejected
    await expect(
      db.query(
        `SELECT public.confirm_marketing_commission_payout_refund_atomic(101, 1, $1, 10000, 'ПКО-ВОЗВРАТ-01-C', 'ref-part-3', 'Лишний')`,
        [payoutOpId]
      )
    ).rejects.toThrow(/PAYOUT_NOT_PENDING_RECONCILIATION/);

    // Re-payout deal 101 with RKO 14 & upgrade to 4%
    await db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 14, '', 'pay-101-repay', 'Valid repay')`);
    await db.query(`INSERT INTO public.payments (id, deal_id, amount_minor, status, settlement_method) VALUES (4, 101, 800000, 'ACTIVE', 'CASH')`);
    const upgradeApp = await db.query(`SELECT public.approve_marketing_commission_atomic(101, 1, 'app-key-101-upgrade', 'Tier 4%') AS res`);
    expect(upgradeApp.rows[0].res.commission_rate_bp).toBe(400);
    expect(upgradeApp.rows[0].res.additional_accrual_minor).toBe(100000);
    await db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 100000, 15, '', 'pay-101-delta', 'Delta 1%')`);

    // Replacement RKO Reconciliation (RKO voided, money WAS paid to marketer):
    // Deal 102 paid via RKO 12 -> RKO 12 voided -> admin reconciles with RKO 17 without moving money again
    await db.query(`SELECT public.approve_marketing_commission_atomic(102, 1, 'app-key-102', 'Approve 102')`);
    await db.query(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 150000, 12, 'Somon Agency', 'pay-102-12', 'Pay 102')`);
    await db.query(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW() WHERE id = 12`);
    const op102 = await db.query(`SELECT id FROM public.marketing_commission_operations WHERE deal_id = 102 AND rko_expense_id = 12`);
    const op102Id = Number(op102.rows[0].id);

    // Reusing refund doc from deal 101 is rejected (if refund path used) - already tested; now test replacement RKO reconciliation
    const recRes = await db.query(
      `SELECT public.reconcile_marketing_commission_payout_with_rko_atomic(102, 1, $1, 17, 'Somon Agency', 'reconcile-102-17', 'Деньги фактически выданы, привязан новый РКО-17') AS res`,
      [op102Id]
    );
    expect(recRes.rows[0].res.paid_amount_minor).toBe(150000);
    expect(recRes.rows[0].res.status).toBe('PAID');
    expect(recRes.rows[0].res.reconciliation_required).toBe(false);
    expect(recRes.rows[0].res.new_rko_expense_id).toBe(17);

    // Verify reconciliation & refund operations created ZERO extra expenses or payments!
    const finalExpenseCount = Number((await db.query(`SELECT count(*)::INT AS c FROM public.expenses`)).rows[0].c);
    const finalPaymentCount = Number((await db.query(`SELECT count(*)::INT AS c FROM public.payments`)).rows[0].c);
    expect(finalExpenseCount).toBe(initialExpenseCount);
    expect(finalPaymentCount).toBe(initialPaymentCount + 1); // only the explicit deal 101 buyer payment id=4

    // If replacement RKO 17 is ALSO voided later, deal 102 cleanly re-enters RECONCILIATION_REQUIRED
    await db.query(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW(), voided_by = 1, void_reason = 'Ошибка кассы №2' WHERE id = 17`);
    const comm102ReVoid = await db.query(`SELECT paid_amount_minor, status, reconciliation_required FROM public.marketing_commissions WHERE deal_id = 102`);
    expect(Number(comm102ReVoid.rows[0].paid_amount_minor)).toBe(150000);
    expect(comm102ReVoid.rows[0].status).toBe('RECONCILIATION_REQUIRED');
    expect(comm102ReVoid.rows[0].reconciliation_required).toBe(true);

    // Second replacement RKO (12 -> 17 -> 18): verify old_rko_expense_id = 17 and full immutable history
    await db.query(`INSERT INTO public.expenses (id, reference, recipient, amount_minor, status) VALUES (18, 'РКО-018', 'Somon Agency', 150000, 'ACTIVE')`);
    const recRes2 = await db.query(
      `SELECT public.reconcile_marketing_commission_payout_with_rko_atomic(102, 1, $1, 18, 'Somon Agency', 'reconcile-102-18', 'Вторая замена РКО после аннулирования РКО-017') AS res`,
      [op102Id]
    );
    expect(recRes2.rows[0].res.old_rko_expense_id).toBe(17);
    expect(recRes2.rows[0].res.new_rko_expense_id).toBe(18);
    expect(recRes2.rows[0].res.initial_rko_expense_id).toBe(12);
    expect(recRes2.rows[0].res.status).toBe('PAID');

    const hist102 = await db.query(
      `SELECT sequence_no, event_type, rko_expense_id, previous_rko_expense_id, status, reason, created_by
       FROM public.marketing_commission_rko_history
       WHERE payout_operation_id = $1
       ORDER BY sequence_no ASC`,
      [op102Id]
    );
    expect(hist102.rows.map((r) => [r.sequence_no, r.event_type, Number(r.rko_expense_id), r.previous_rko_expense_id ? Number(r.previous_rko_expense_id) : null, r.status])).toEqual([
      [1, 'INITIAL_PAYOUT', 12, null, 'ACTIVE'],
      [2, 'RKO_VOIDED', 12, null, 'VOIDED_RECONCILIATION_REQUIRED'],
      [3, 'REPLACEMENT_RKO', 17, 12, 'ACTIVE'],
      [4, 'RKO_VOIDED', 17, null, 'VOIDED_RECONCILIATION_REQUIRED'],
      [5, 'REPLACEMENT_RKO', 18, 17, 'ACTIVE'],
    ]);

    // Verify immutability of marketing_commission_rko_history (UPDATE & DELETE blocked)
    await expect(db.query(`UPDATE public.marketing_commission_rko_history SET reason = 'tampered' WHERE payout_operation_id = $1`, [op102Id])).rejects.toThrow(/IMMUTABLE_RKO_HISTORY/);
    await expect(db.query(`DELETE FROM public.marketing_commission_rko_history WHERE payout_operation_id = $1`, [op102Id])).rejects.toThrow(/IMMUTABLE_RKO_HISTORY/);

    // Verify PostgreSQL unique index blocks direct duplicate RKO usage across initial & replacement
    await expect(
      db.query(
        `INSERT INTO public.marketing_commission_rko_history (deal_id, payout_operation_id, sequence_no, event_type, rko_expense_id, rko_reference, status, reason)
         VALUES (102, $1, 99, 'REPLACEMENT_RKO', 12, 'РКО-012', 'ACTIVE', 'dup')`,
        [op102Id]
      )
    ).rejects.toThrow(/duplicate key value violates unique constraint/);

    // Void RKO 18 to test race with RKO 16
    await db.query(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW(), voided_by = 1, void_reason = 'Ошибка кассы №3' WHERE id = 18`);

    // Concurrent race between reconcile with RKO 16 and voiding RKO 16 -> deadlock-free, deterministic
    const [raceRec, raceVoid] = await Promise.allSettled([
      db.query(`SELECT public.reconcile_marketing_commission_payout_with_rko_atomic(102, 1, $1, 16, '', 'reconcile-102-16-race', 'Race RKO 16') AS res`, [op102Id]),
      db.query(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW() WHERE id = 16`),
    ]);
    expect(raceVoid.status).toBe('fulfilled');
    const comm102Race = await db.query(`SELECT paid_amount_minor, status FROM public.marketing_commissions WHERE deal_id = 102`);
    expect(Number(comm102Race.rows[0].paid_amount_minor)).toBe(150000);
    expect(comm102Race.rows[0].status).toBe('RECONCILIATION_REQUIRED');
    if (raceRec.status === 'rejected') {
      expect(String(raceRec.reason?.message || raceRec.reason)).toMatch(/RKO_VOIDED/);
    }

    // Clean rollback 057
    await db.query(`UPDATE public.marketing_commissions SET status = 'PAID', reconciliation_required = FALSE WHERE deal_id = 102`);
    const rollback057 = fs.readFileSync(path.join(migrationsDir, 'rollback_057_marketing_commission_atomic_ops_and_rko_guard.sql'), 'utf8');
    await db.exec(rollback057);
    const tblCheck = await db.query(`SELECT to_regclass('public.marketing_commission_operations') AS reg`);
    expect(tblCheck.rows[0].reg).toBeNull();
  });
});
