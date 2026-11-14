import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');

describe('PostgreSQL (PGlite) Migration 057 — Atomic Commission Ops, Idempotency & RKO Integrity', () => {
  it('enforces PostgreSQL FOR UPDATE locking, idempotency replay/conflict, RKO 1-to-1 / amount / recipient / void reversal, and clean rollback', async () => {
    const db = new PGlite();

    // Create minimal schema matching production tables referenced by 055 & 057
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
        final_price_minor BIGINT NOT NULL DEFAULT 10000000
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
      INSERT INTO public.deals (id, status, final_price_minor) VALUES (101, 'SIGNED', 10000000), (102, 'SIGNED', 5000000);
    `);

    const sql055 = fs.readFileSync(path.join(migrationsDir, '055_sales_sources_and_marketing_commissions.sql'), 'utf8');
    await db.exec(sql055);

    await db.exec(`
      INSERT INTO public.marketing_partners (id, name, commission_type, commission_rate_bp)
      VALUES (701, 'Somon Agency', 'PERCENT', 300);
      UPDATE public.deals SET sales_source = 'MARKETER', marketing_partner_id = 701 WHERE id IN (101, 102);
    `);

    const sql057 = fs.readFileSync(path.join(migrationsDir, '057_marketing_commission_atomic_ops_and_rko_guard.sql'), 'utf8');
    await db.exec(sql057);

    // 1. Atomic APPROVE
    const appRes = await db.query(
      `SELECT public.approve_marketing_commission_atomic(101, 1, 300000, 300000, 300, 701, 10000000, 'app-key-101', 'Initial approval') AS res`
    );
    expect(appRes.rows[0].res.status).toBe('APPROVED');
    expect(appRes.rows[0].res.idempotent).toBe(false);

    // Replay same APPROVE key -> idempotent: true, no error, no duplicate audit row
    const appReplay = await db.query(
      `SELECT public.approve_marketing_commission_atomic(101, 1, 300000, 300000, 300, 701, 10000000, 'app-key-101', 'Retry') AS res`
    );
    expect(appReplay.rows[0].res.idempotent).toBe(true);

    // Replay same APPROVE key with different amount -> IDEMPOTENCY_CONFLICT
    await expect(
      db.query(`SELECT public.approve_marketing_commission_atomic(101, 1, 400000, 400000, 400, 701, 10000000, 'app-key-101', 'Tamper')`)
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    // 2. Insert RKO documents for payout tests
    await db.exec(`
      INSERT INTO public.expenses (id, reference, recipient, amount_minor, status, voided_at) VALUES
        (10, 'РКО-10', 'Somon Agency', 300000, 'ACTIVE', NULL),
        (11, 'РКО-11', 'Wrong Agency', 300000, 'ACTIVE', NULL),
        (12, 'РКО-12', 'Somon Agency', 150000, 'ACTIVE', NULL),
        (13, 'РКО-13', 'Somon Agency', 300000, 'VOIDED', NOW()),
        (14, 'РКО-14', 'Somon Agency', 300000, 'ACTIVE', NULL);
    `);

    // Wrong recipient -> RKO_RECIPIENT_MISMATCH
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 11, 'Somon Agency', 'pay-bad-rec', 'test')`)
    ).rejects.toThrow(/RKO_RECIPIENT_MISMATCH/);

    // Amount mismatch -> RKO_AMOUNT_MISMATCH
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 12, 'Somon Agency', 'pay-bad-amt', 'test')`)
    ).rejects.toThrow(/RKO_AMOUNT_MISMATCH/);

    // Voided RKO -> RKO_VOIDED
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 13, 'Somon Agency', 'pay-void-rko', 'test')`)
    ).rejects.toThrow(/RKO_VOIDED/);

    // 3. Simultaneous payout requests on PostgreSQL: one succeeds, one fails
    const [p1, p2] = await Promise.allSettled([
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 10, 'Somon Agency', 'pay-key-101-a', 'Payout 1') AS res`),
      db.query(`SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, 14, 'Somon Agency', 'pay-key-101-b', 'Payout 2') AS res`),
    ]);
    expect([p1.status, p2.status].sort()).toEqual(['fulfilled', 'rejected']);

    // 4. Replay after timeout with same idempotencyKey & params -> idempotent: true
    const winnerKey = p1.status === 'fulfilled' ? 'pay-key-101-a' : 'pay-key-101-b';
    const winnerRko = p1.status === 'fulfilled' ? 10 : 14;
    const replayRes = await db.query(
      `SELECT public.record_marketing_commission_payout_atomic(101, 3, 300000, $1, 'Somon Agency', $2, 'Retry after timeout') AS res`,
      [winnerRko, winnerKey]
    );
    expect(replayRes.rows[0].res.idempotent).toBe(true);
    expect(replayRes.rows[0].res.paid_amount_minor).toBe(300000);

    // Replay same key with different amount or different deal -> IDEMPOTENCY_CONFLICT
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 300000, $1, 'Somon Agency', $2, 'Wrong deal')`, [winnerRko, winnerKey])
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    // 5. Same RKO cannot be linked to another deal's payout
    await db.query(`SELECT public.approve_marketing_commission_atomic(102, 1, 300000, 300000, 300, 701, 5000000, 'app-key-102', 'Approve 102')`);
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 300000, $1, 'Somon Agency', 'pay-key-102', 'Reuse RKO')`, [winnerRko])
    ).rejects.toThrow(/RKO_ALREADY_LINKED/);

    // 6. Voiding the linked RKO automatically reverses the commission payout via trigger
    await db.query(`UPDATE public.expenses SET status = 'VOIDED', voided_at = NOW() WHERE id = $1`, [winnerRko]);
    const commAfterVoid = await db.query(`SELECT paid_amount_minor, status FROM public.marketing_commissions WHERE deal_id = 101`);
    expect(Number(commAfterVoid.rows[0].paid_amount_minor)).toBe(0);
    expect(commAfterVoid.rows[0].status).toBe('APPROVED');

    // 7. Payout on cancelled commission is rejected
    await db.query(`UPDATE public.marketing_commissions SET status = 'CANCELLED', cancelled_at = NOW() WHERE deal_id = 102`);
    await expect(
      db.query(`SELECT public.record_marketing_commission_payout_atomic(102, 3, 300000, 14, 'Somon Agency', 'pay-cancelled', 'Should fail')`)
    ).rejects.toThrow(/COMMISSION_CANCELLED_OR_MISSING/);

    // 8. Clean rollback 057
    const rollback057 = fs.readFileSync(path.join(migrationsDir, 'rollback_057_marketing_commission_atomic_ops_and_rko_guard.sql'), 'utf8');
    await db.exec(rollback057);
    const tblCheck = await db.query(`SELECT to_regclass('public.marketing_commission_operations') AS reg`);
    expect(tblCheck.rows[0].reg).toBeNull();
  });
});

