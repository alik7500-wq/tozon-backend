import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');

describe('Migration 058 — Calculation-Only Marketer Commission (0/2/3/4%, Barter, Refunds, Payouts Disabled)', () => {
  it('computes 0/2/3/4% accurately with payments, barter & refunds while keeping payouts/RKO disabled', async () => {
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

      INSERT INTO public.deals (id, status, final_price_minor, barter_amount_minor, refund_amount_minor) VALUES
        (1, 'SIGNED', 10000000, 0, 0),       -- 4.99% -> 0%
        (2, 'SIGNED', 10000000, 0, 0),       -- 5.00% -> 2%
        (3, 'SIGNED', 10000000, 300000, 0),  -- 7% cash + 3% barter_amount_minor = 10% -> 3%
        (4, 'SIGNED', 10000000, 0, 200000),  -- 16% cash + 2% barter_payment - 2% refund = 16% -> 4%
        (5, 'SIGNED', 10000000, 0, 700000);  -- 15% cash - 7% refund = 8% -> 2%

      INSERT INTO public.payments (deal_id, amount_minor, status, settlement_method) VALUES
        (1, 499000, 'ACTIVE', 'CASH'),
        (1, 500000, 'VOIDED', 'CASH'),      -- voided ignored
        (2, 500000, 'ACTIVE', 'CASH'),
        (3, 700000, 'ACTIVE', 'CASH'),
        (4, 1600000, 'ACTIVE', 'CASH'),
        (4, 200000, 'ACTIVE', 'BARTER'),
        (5, 1500000, 'ACTIVE', 'CASH');
    `);

    const sql055 = fs.readFileSync(path.join(migrationsDir, '055_sales_sources_and_marketing_commissions.sql'), 'utf8');
    await db.exec(sql055);

    const sql058 = fs.readFileSync(path.join(migrationsDir, '058_marketing_commission_calculation_only.sql'), 'utf8');
    await db.exec(sql058);

    // 1. Verify tiered calculations
    const r1 = (await db.query(`SELECT * FROM public.compute_marketing_commission_from_db(1)`)).rows[0];
    expect(Number(r1.settled_minor)).toBe(499000);
    expect(r1.rate_bp).toBe(0);
    expect(Number(r1.calculated_minor)).toBe(0);

    const r2 = (await db.query(`SELECT * FROM public.compute_marketing_commission_from_db(2)`)).rows[0];
    expect(Number(r2.settled_minor)).toBe(500000);
    expect(r2.rate_bp).toBe(200);
    expect(Number(r2.calculated_minor)).toBe(200000);

    const r3 = (await db.query(`SELECT * FROM public.compute_marketing_commission_from_db(3)`)).rows[0];
    expect(Number(r3.settled_minor)).toBe(1000000);
    expect(r3.rate_bp).toBe(300);
    expect(Number(r3.calculated_minor)).toBe(300000);

    const r4 = (await db.query(`SELECT * FROM public.compute_marketing_commission_from_db(4)`)).rows[0];
    expect(Number(r4.settled_minor)).toBe(1600000);
    expect(r4.rate_bp).toBe(400);
    expect(Number(r4.calculated_minor)).toBe(400000);

    const r5 = (await db.query(`SELECT * FROM public.compute_marketing_commission_from_db(5)`)).rows[0];
    expect(Number(r5.settled_minor)).toBe(800000);
    expect(r5.rate_bp).toBe(200);
    expect(Number(r5.calculated_minor)).toBe(200000);

    // 2. Verify security attributes
    const procMeta = await db.query(`
      SELECT prosecdef, proconfig,
             has_function_privilege('anon', oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('public', oid, 'EXECUTE') AS pub_exec,
             has_function_privilege('service_role', oid, 'EXECUTE') AS srv_exec
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'compute_marketing_commission_from_db';
    `);
    expect(procMeta.rows).toHaveLength(1);
    expect(procMeta.rows[0].prosecdef).toBe(true);
    expect(procMeta.rows[0].proconfig).toContain('search_path=public, pg_temp');
    expect(procMeta.rows[0].anon_exec).toBe(false);
    expect(procMeta.rows[0].auth_exec).toBe(false);
    expect(procMeta.rows[0].pub_exec).toBe(false);
    expect(procMeta.rows[0].srv_exec).toBe(true);

    // 3. Verify payout/RKO/reconciliation tables & RPCs are NOT created
    const opsTable = await db.query(`SELECT to_regclass('public.marketing_commission_operations') AS reg`);
    const histTable = await db.query(`SELECT to_regclass('public.marketing_commission_rko_history') AS reg`);
    expect(opsTable.rows[0].reg).toBeNull();
    expect(histTable.rows[0].reg).toBeNull();

    // 4. Verify clean rollback 058
    const rollback058 = fs.readFileSync(path.join(migrationsDir, 'rollback_058_marketing_commission_calculation_only.sql'), 'utf8');
    await db.exec(rollback058);
    const fnAfter = await db.query(`
      SELECT count(*)::INT AS c FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = 'compute_marketing_commission_from_db'
    `);
    expect(fnAfter.rows[0].c).toBe(0);
  });
});
