import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');

describe('PostgreSQL (PGlite) Migration 057 — Hardened Atomic Commission Ops, RKO Reconciliation & Refund Confirmation', () => {
  it('verifies all 8 scenarios: payout, replay, RKO void without auto-reduction, confirmed refund, repeat-payout block, rate upgrade, refund ceiling, concurrent ops & rollback', async () => {
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

    // Verify RPC security & search_path
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
          'guard_void_rko_linked_commission'
        )
      ORDER BY proname
    `);
    expect(procMeta.rows).toHaveLength(5);
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
        (13, 'РКО-13', 'Somon Agency', 300000, 'VOIDED', NOW()),
        (14, 'РКО-14', 'Somon Agency', 300000, 'ACTIVE', NULL),
        (15, 'РКО-15', 'Somon Agency', 100000, 'ACTIVE', NULL),
        (16, 'РКО-16', 'Somon Agency', 150000, 'ACTIVE', NULL);
    `);

    // Mandatory DB partner check even with empty p_expected_partner_name
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 11, '', 'pay-bad-rec', 'test')`)
    ).rejects.toThrow(/RKO_RECIPIENT_MISMATCH/);

    // Scenario 7: Lowering calculated commission after buyer refund blocks payout
    await db.query(`UPDATE public.deals SET refund_amount_minor = 500000 WHERE id = 101`);
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 10, 'Somon Agency', 'pay-exceeds-calc', 'test')`)
    ).rejects.toThrow(/PAYOUT_EXCEEDS_CALCULATED/);
    await db.query(`UPDATE public.deals SET refund_amount_minor = 0 WHERE id = 101`);

    // Scenario 1 & 2 & 8: Normal payout + concurrent same-key idempotency replay
    const [p1, p2] = await Promise.all([
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 10, 'Somon Agency', 'pay-101-k1', 'Payout 101') AS res`),
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 10, 'Somon Agency', 'pay-101-k1', 'Payout 101') AS res`),
    ]);
    expect([p1.rows[0].res.idempotent, p2.rows[0].res.idempotent].sort()).toEqual([false, true]);
    expect(p1.rows[0].res.paid_amount_minor).toBe(300000);
    expect(p1.rows[0].res.status).toBe('PAID');

    // Scenario 3: Voiding RKO 10 WITHOUT actual cash refund from marketer
    // MUST preserve paid_amount_minor = 300000 and set RECONCILIATION_REQUIRED
    await db.query(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW() WHERE id = 10`);
    const commAfterVoid = await db.query(`
      SELECT paid_amount_minor, status, reconciliation_required, reconciliation_reason
      FROM public.marketing_commissions WHERE deal_id = 101
    `);
    expect(Number(commAfterVoid.rows[0].paid_amount_minor)).toBe(300000);
    expect(commAfterVoid.rows[0].status).toBe('RECONCILIATION_REQUIRED');
    expect(commAfterVoid.rows[0].reconciliation_required).toBe(true);

    const opAfterVoid = await db.query(`
      SELECT id, reconciliation_status, voided_at FROM public.marketing_commission_operations
      WHERE deal_id = 101 AND rko_expense_id = 10
    `);
    expect(opAfterVoid.rows[0].reconciliation_status).toBe('RECONCILIATION_REQUIRED');
    expect(opAfterVoid.rows[0].voided_at).not.toBeNull();
    const payoutOpId = Number(opAfterVoid.rows[0].id);

    // Scenario 5: Attempted repeat payout after RKO void is BLOCKED (even with a brand new RKO 14)
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 14, 'Somon Agency', 'pay-101-repeat', 'Repeat')`)
    ).rejects.toThrow(/COMMISSION_RECONCILIATION_REQUIRED/);

    // Attempted reuse of voided RKO 10 is also BLOCKED
    await db.query(`SELECT public.approve_marketing_commission_atomic(102, 1, 'app-key-102', 'Approve 102')`);
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 150000, 10, 'Somon Agency', 'pay-102-void-rko', 'Reuse voided')`)
    ).rejects.toThrow(/RKO_VOIDED/);

    // Scenario 4: Documented refund confirmation (CONFIRM_PAYOUT_REFUND) reduces paid_amount_minor & clears reconciliation
    const refundRes = await db.query(
      `SELECT public.confirm_marketing_commission_payout_refund_atomic(101, 1, $1, 300000, 'ПКО-ВОЗВРАТ-01', 'refund-101-1', 'Маркетолог вернул деньги в кассу') AS res`,
      [payoutOpId]
    );
    expect(refundRes.rows[0].res.paid_amount_minor).toBe(0);
    expect(refundRes.rows[0].res.status).toBe('APPROVED');
    expect(refundRes.rows[0].res.reconciliation_required).toBe(false);

    // Repeating refund on same payout operation is rejected
    await expect(
      db.query(
        `SELECT public.confirm_marketing_commission_payout_refund_atomic(101, 1, $1, 300000, 'ПКО-ВОЗВРАТ-02', 'refund-101-2', 'Повторный возврат')`,
        [payoutOpId]
      )
    ).rejects.toThrow(/PAYOUT_NOT_PENDING_RECONCILIATION/);

    // Reusing the same refund document ref on another deal/operation is also rejected
    await db.query(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 150000, 12, 'Somon Agency', 'pay-102-doc', 'Pay 102')`);
    await db.query(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW() WHERE id = 12`);
    const op102 = await db.query(`SELECT id FROM public.marketing_commission_operations WHERE deal_id = 102 AND rko_expense_id = 12`);
    await expect(
      db.query(
        `SELECT public.confirm_marketing_commission_payout_refund_atomic(102, 1, $1, 150000, 'пко-возврат-01', 'refund-102-reuse-doc', 'Reuse doc')`,
        [Number(op102.rows[0].id)]
      )
    ).rejects.toThrow(/REFUND_DOCUMENT_ALREADY_USED/);
    // Resolve deal 102 reconciliation with a unique refund document before Scenario 8
    await db.query(
      `SELECT public.confirm_marketing_commission_payout_refund_atomic(102, 1, $1, 150000, 'ПКО-ВОЗВРАТ-102', 'refund-102-valid', 'Возврат по 102')`,
      [Number(op102.rows[0].id)]
    );

    // Now re-payout with a new RKO 14 succeeds
    const repayoutRes = await db.query(
      `SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 14, '', 'pay-101-repay', 'Valid repay') AS res`
    );
    expect(repayoutRes.rows[0].res.paid_amount_minor).toBe(300000);
    expect(repayoutRes.rows[0].res.status).toBe('PAID');

    // Scenario 6: Buyer pays more -> rate increases from 3% to 4% -> incremental approval & payout of delta (100,000)
    await db.query(`INSERT INTO public.payments (id, deal_id, amount_minor, status, settlement_method) VALUES (4, 101, 800000, 'ACTIVE', 'CASH')`);
    const upgradeApp = await db.query(
      `SELECT public.approve_marketing_commission_atomic(101, 1, 'app-key-101-upgrade', 'Tier 4%') AS res`
    );
    expect(upgradeApp.rows[0].res.commission_rate_bp).toBe(400);
    expect(upgradeApp.rows[0].res.approved_amount_minor).toBe(400000);
    expect(upgradeApp.rows[0].res.additional_accrual_minor).toBe(100000);
    expect(upgradeApp.rows[0].res.status).toBe('PARTIALLY_PAID');

    const deltaPay = await db.query(
      `SELECT public.record_marketing_commission_payout_atomic(101, 3, 100000, 15, '', 'pay-101-delta', 'Delta 1%') AS res`
    );
    expect(deltaPay.rows[0].res.paid_amount_minor).toBe(400000);
    expect(deltaPay.rows[0].res.status).toBe('PAID');

    // Scenario 8: Concurrent payout on deal 102 vs voiding RKO 16 -> no deadlock, deterministic state
    const [racePay, raceVoid] = await Promise.allSettled([
      db.query(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 150000, 16, '', 'pay-102-race', 'Race') AS res`),
      db.query(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW() WHERE id = 16`),
    ]);
    expect(raceVoid.status).toBe('fulfilled');
    const comm102 = await db.query(`SELECT paid_amount_minor, status FROM public.marketing_commissions WHERE deal_id = 102`);
    if (racePay.status === 'fulfilled') {
      // Payout ran first, then void trigger preserved paid_amount_minor and flagged RECONCILIATION_REQUIRED
      expect(Number(comm102.rows[0].paid_amount_minor)).toBe(150000);
      expect(comm102.rows[0].status).toBe('RECONCILIATION_REQUIRED');
    } else {
      expect(String(racePay.reason?.message || racePay.reason)).toMatch(/RKO_VOIDED/);
      expect(Number(comm102.rows[0].paid_amount_minor)).toBe(0);
    }

    // Clean rollback 057 (after confirming or resetting any RECONCILIATION_REQUIRED on 102 if racePay won)
    await db.query(`UPDATE public.marketing_commissions SET status = 'APPROVED', paid_amount_minor = 0 WHERE deal_id = 102`);
    const rollback057 = fs.readFileSync(path.join(migrationsDir, 'rollback_057_marketing_commission_atomic_ops_and_rko_guard.sql'), 'utf8');
    await db.exec(rollback057);
    const tblCheck = await db.query(`SELECT to_regclass('public.marketing_commission_operations') AS reg`);
    expect(tblCheck.rows[0].reg).toBeNull();
  });
});
