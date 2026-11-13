import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');
const externalBackupDir = 'd:/tozon-crm/backups/pre_v3_20261113';

describe('PostgreSQL (PGlite) Verification — Full Backup Restore + Migrations 055 & 056 + Rollbacks + Zero-Loss Commission History', () => {
  it('restores full production SQL dump in isolated PGlite, applies 055 & 056, enforces RLS/FK/Unique/Check/Triggers, and safely rolls back & re-applies without losing source or commission history', async () => {
    const db = new PGlite();

    const externalSqlPath = path.join(externalBackupDir, 'full_production_backup_20261113.sql');
    const hasExternalBackup = fs.existsSync(externalSqlPath);

    if (hasExternalBackup) {
      // 1. Restore full production SQL backup (schema + data + functions + triggers + RLS)
      const fullBackupSql = fs.readFileSync(externalSqlPath, 'utf8');
      await db.exec(fullBackupSql);

      // Verify restored row counts match production manifest
      const countsRes = await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM public.users) AS users_cnt,
          (SELECT COUNT(*)::int FROM public.projects) AS projects_cnt,
          (SELECT COUNT(*)::int FROM public.buildings) AS buildings_cnt,
          (SELECT COUNT(*)::int FROM public.units) AS units_cnt,
          (SELECT COUNT(*)::int FROM public.deals) AS deals_cnt,
          (SELECT COUNT(*)::int FROM public.deal_payment_schedules) AS schedules_cnt,
          (SELECT COUNT(*)::int FROM public.payments) AS payments_cnt,
          (SELECT COUNT(*)::int FROM public.expenses) AS expenses_cnt,
          (SELECT COUNT(*)::int FROM public.dictionaries) AS dicts_cnt,
          (SELECT COUNT(*)::int FROM public.deal_audit_logs) AS logs_cnt
      `);
      expect(countsRes.rows[0]).toEqual({
        users_cnt: 9,
        projects_cnt: 2,
        buildings_cnt: 4,
        units_cnt: 330,
        deals_cnt: 97,
        schedules_cnt: 2554,
        payments_cnt: 400,
        expenses_cnt: 605,
        dicts_cnt: 62,
        logs_cnt: 186,
      });

      // Verify stored functions and RLS from backup exist
      const fnRes = await db.query(`
        SELECT proname FROM pg_proc
        WHERE proname IN ('update_deal_atomic', 'recalculate_deal_schedules_atomic', 'fn_assign_lead_atomic')
        ORDER BY proname
      `);
      expect(fnRes.rows.map((r) => r.proname)).toEqual([
        'fn_assign_lead_atomic',
        'recalculate_deal_schedules_atomic',
        'update_deal_atomic',
      ]);
    } else {
      // Fallback minimal schema for CI environments without external backup directory
      await db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres SUPERUSER NOLOGIN; END IF;
        END $$;

        CREATE TABLE public.users (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
        CREATE TABLE public.units (id BIGSERIAL PRIMARY KEY, unit_number TEXT NOT NULL, unit_kind TEXT DEFAULT 'APARTMENT', status TEXT DEFAULT 'AVAILABLE', archived_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE public.deals (id BIGSERIAL PRIMARY KEY, unit_id BIGINT REFERENCES public.units(id), status TEXT DEFAULT 'SIGNED', cancelled_at TIMESTAMPTZ, final_price_minor BIGINT DEFAULT 5000000, created_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE public.dictionaries (id TEXT PRIMARY KEY DEFAULT md5(random()::text), type TEXT NOT NULL, code TEXT, name TEXT NOT NULL, is_active BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 100, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE public.deal_audit_logs (id BIGSERIAL PRIMARY KEY, deal_id BIGINT REFERENCES public.deals(id) ON DELETE CASCADE, user_id BIGINT, action VARCHAR(50) NOT NULL, changes_json JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());

        INSERT INTO public.users (id, name, role) VALUES (1, 'Admin', 'ADMIN');
        INSERT INTO public.units (id, unit_number, status) VALUES (113, '31', 'SOLD'), (112, '32', 'SOLD'), (162, '10', 'AVAILABLE');
        INSERT INTO public.deals (id, unit_id, status, final_price_minor) VALUES (11, 113, 'SIGNED', 5000000), (12, 112, 'SIGNED', 6000000);
      `);
    }

    // 2. Simulate hybrid records created BEFORE migration 055 is applied:
    //    - 1 marketing partner with UUID id
    //    - 1 marketing partner with numeric id ('900')
    //    - 2 deal source confirmations in deal_audit_logs (deals #11 and #12)
    //    - 1 commission approval & partial payout in deal_audit_logs for deal #11
    const uuidPartnerId = 'a0ebb611-75e2-470b-99cd-e10decfeebb6';
    await db.query(
      `INSERT INTO public.dictionaries (id, type, name, code, is_active)
       VALUES ($1, 'MARKETING_PARTNER', 'UUID Agency Somon', $2, TRUE)`,
      [
        uuidPartnerId,
        JSON.stringify({
          contactPerson: 'Карим',
          phone: '+992920009988',
          commissionType: 'PERCENT',
          commissionRateBp: 250,
          commissionTerms: 'По факту оплаты',
        }),
      ]
    );

    await db.query(
      `INSERT INTO public.dictionaries (id, type, name, code, is_active)
       VALUES ('900', 'MARKETING_PARTNER', 'Somon Marketing Agency', $1, TRUE)`,
      [
        JSON.stringify({
          contactPerson: 'Рустам',
          phone: '+992920001122',
          commissionType: 'PERCENT',
          commissionRateBp: 300,
          commissionTerms: 'После 30% оплаты',
        }),
      ]
    );

    await db.query(
      `INSERT INTO public.deal_audit_logs (id, deal_id, user_id, action, changes_json, created_at)
       VALUES (9001, 11, 1, 'SET_SALES_SOURCE', $1, '2026-11-12T10:00:00Z')`,
      [
        JSON.stringify({
          old_source: 'UNSPECIFIED',
          new_source: 'MARKETER',
          new_partner_id: 900,
          marketer_name: 'Алишер',
          reason: 'Проверка договора администратором',
        }),
      ]
    );

    await db.query(
      `INSERT INTO public.deal_audit_logs (id, deal_id, user_id, action, changes_json, created_at)
       VALUES (9002, 12, 1, 'SET_SALES_SOURCE', $1, '2026-11-12T10:05:00Z')`,
      [
        JSON.stringify({
          old_source: 'UNSPECIFIED',
          new_source: 'MARKETER',
          new_partner_id: uuidPartnerId,
          new_partner_name: 'UUID Agency Somon',
          marketer_name: 'Парвиз',
          reason: 'Подтверждение UUID партнёра',
        }),
      ]
    );

    await db.query(
      `INSERT INTO public.deal_audit_logs (id, deal_id, user_id, action, changes_json, created_at)
       VALUES (9003, 11, 1, 'MARKETING_COMMISSION_UPDATE', $1, '2026-11-12T11:00:00Z')`,
      [
        JSON.stringify({
          action_type: 'RECORD_PAYOUT',
          commission_type: 'PERCENT',
          commission_rate_bp: 300,
          calculated_amount_minor: 150000,
          approved_amount_minor: 150000,
          paid_amount_minor: 50000,
          status: 'PARTIALLY_PAID',
          accrued_at: '2026-11-12T10:00:00Z',
          approved_at: '2026-11-12T10:30:00Z',
          approved_by: 1,
          paid_at: '2026-11-12T11:00:00Z',
          notes: 'Первая выплата маркетологу 500 USD',
        }),
      ]
    );

    // 3. Execute Migration 055 and Migration 056
    const mig055Sql = fs.readFileSync(
      path.join(migrationsDir, '055_sales_sources_and_marketing_commissions.sql'),
      'utf8'
    );
    const mig056Sql = fs.readFileSync(
      path.join(migrationsDir, '056_unit_status_history_and_reserved_at.sql'),
      'utf8'
    );

    await db.exec(mig055Sql);
    await db.exec(mig056Sql);

    // 4. Verify hybrid partner #900 and UUID partner migrated to public.marketing_partners with zero loss
    const mpRes = await db.query(`SELECT * FROM public.marketing_partners WHERE id = 900`);
    expect(mpRes.rows.length).toBe(1);
    expect(mpRes.rows[0].name).toBe('Somon Marketing Agency');
    expect(mpRes.rows[0].commission_type).toBe('PERCENT');
    expect(mpRes.rows[0].commission_rate_bp).toBe(300);

    // 5. Verify hybrid commission on deal #11 migrated to public.marketing_commissions with zero loss
    const comm11Res = await db.query(
      `SELECT deal_id, partner_id, commission_rate_bp, calculated_amount_minor, approved_amount_minor, paid_amount_minor, status, notes
       FROM public.marketing_commissions WHERE deal_id = 11`
    );
    expect(comm11Res.rows[0]).toEqual({
      deal_id: 11,
      partner_id: 900,
      commission_rate_bp: 300,
      calculated_amount_minor: 150000,
      approved_amount_minor: 150000,
      paid_amount_minor: 50000,
      status: 'PARTIALLY_PAID',
      notes: 'Первая выплата маркетологу 500 USD',
    });

    // 6. Verify deals #11 and #12 received their hybrid MARKETER sources and all other 72 active signed apartment deals remain UNSPECIFIED
    const deal12Res = await db.query(
      `SELECT d.sales_source, mp.name AS partner_name, mp.legacy_dictionary_id, d.marketer_name
       FROM public.deals d
       JOIN public.marketing_partners mp ON mp.id = d.marketing_partner_id
       WHERE d.id = 12`
    );
    expect(deal12Res.rows[0]).toEqual({
      sales_source: 'MARKETER',
      partner_name: 'UUID Agency Somon',
      legacy_dictionary_id: uuidPartnerId,
      marketer_name: 'Парвиз',
    });

    if (hasExternalBackup) {
      const unspecRes = await db.query(`
        SELECT COUNT(*)::int AS cnt
        FROM public.deals d
        JOIN public.units u ON u.id = d.unit_id
        WHERE d.status = 'SIGNED'
          AND d.cancelled_at IS NULL
          AND u.unit_kind = 'APARTMENT'
          AND u.archived_at IS NULL
          AND d.sales_source = 'UNSPECIFIED'
      `);
      expect(unspecRes.rows[0].cnt).toBe(72);
    }

    // 7. Verify RLS is enabled on all 4 new tables and anon access is denied while service_role has full access
    const rlsRes = await db.query(`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN (
        'marketing_partners',
        'deal_source_history',
        'marketing_commissions',
        'unit_status_history'
      )
      ORDER BY relname
    `);
    expect(rlsRes.rows).toEqual([
      { relname: 'deal_source_history', relrowsecurity: true },
      { relname: 'marketing_commissions', relrowsecurity: true },
      { relname: 'marketing_partners', relrowsecurity: true },
      { relname: 'unit_status_history', relrowsecurity: true },
    ]);

    // Verify anon role is strictly denied access to marketing_commissions
    await db.exec(`SET ROLE anon;`);
    await expect(db.query(`SELECT * FROM public.marketing_commissions`)).rejects.toThrow();
    await db.exec(`RESET ROLE;`);

    // 8. Verify DB constraints: UNIQUE(deal_id) on marketing_commissions, paid <= approved check, ON DELETE RESTRICT on partner
    await expect(
      db.query(
        `INSERT INTO public.marketing_commissions (deal_id, partner_id, status) VALUES (11, 900, 'CALCULATED')`
      )
    ).rejects.toThrow();

    await expect(
      db.query(
        `UPDATE public.marketing_commissions SET paid_amount_minor = 200000 WHERE deal_id = 11`
      )
    ).rejects.toThrow();

    await expect(
      db.query(`DELETE FROM public.marketing_partners WHERE id = 900`)
    ).rejects.toThrow();

    // 9. Verify trigger trg_log_unit_status_change on public.units (Migration 056)
    const availUnitRes = await db.query(
      `SELECT id FROM public.units WHERE status = 'AVAILABLE' AND unit_kind = 'APARTMENT' LIMIT 1`
    );
    const targetUnitId = availUnitRes.rows[0].id;
    await db.query(`UPDATE public.units SET status = 'RESERVED' WHERE id = $1`, [targetUnitId]);
    const unitHistRes = await db.query(
      `SELECT unit_id, old_status, new_status, reason FROM public.unit_status_history WHERE unit_id = $1`,
      [targetUnitId]
    );
    expect(unitHistRes.rows.length).toBe(1);
    expect(unitHistRes.rows[0].old_status).toBe('AVAILABLE');
    expect(unitHistRes.rows[0].new_status).toBe('RESERVED');

    // 10. Insert a new commission directly in public.marketing_commissions (for deal #12) and a new partner,
    //     then execute Rollback 056 & Rollback 055 and verify ZERO loss of commission history!
    const uuidPartnerDbRow = await db.query(
      `SELECT id FROM public.marketing_partners WHERE legacy_dictionary_id = $1`,
      [uuidPartnerId]
    );
    const uuidPartnerDbId = uuidPartnerDbRow.rows[0].id;

    await db.query(
      `INSERT INTO public.marketing_commissions (
        deal_id, partner_id, contract_price_minor, commission_type, commission_rate_bp,
        calculated_amount_minor, approved_amount_minor, paid_amount_minor, status, approved_by, notes
      ) VALUES (12, $1, 6000000, 'PERCENT', 250, 150000, 150000, 150000, 'PAID', 1, 'Полная выплата по сделке 12')`,
      [uuidPartnerDbId]
    );

    await db.query(
      `INSERT INTO public.marketing_partners (name, contact_person, phone, commission_type, commission_rate_bp)
       VALUES ('New Post-055 Partner', 'Фарход', '+992927778899', 'NONE', 0)`
    );

    const rollback056Sql = fs.readFileSync(
      path.join(migrationsDir, 'rollback_056_unit_status_history_and_reserved_at.sql'),
      'utf8'
    );
    const rollback055Sql = fs.readFileSync(
      path.join(migrationsDir, 'rollback_055_sales_sources_and_marketing_commissions.sql'),
      'utf8'
    );

    await db.exec(rollback056Sql);
    await db.exec(rollback055Sql);

    // Verify commission for deal #12 was preserved into public.deal_audit_logs by rollback_055
    const preservedComm12Res = await db.query(
      `SELECT changes_json FROM public.deal_audit_logs
       WHERE deal_id = 12 AND action = 'MARKETING_COMMISSION_UPDATE'`
    );
    expect(preservedComm12Res.rows.length).toBe(1);
    expect(preservedComm12Res.rows[0].changes_json.status).toBe('PAID');
    expect(preservedComm12Res.rows[0].changes_json.paid_amount_minor).toBe(150000);

    // 11. Re-apply 055 & 056 and verify both deal #11 and deal #12 commissions are restored in marketing_commissions
    await db.exec(mig055Sql);
    await db.exec(mig056Sql);

    const restoredComms = await db.query(
      `SELECT deal_id, status, paid_amount_minor FROM public.marketing_commissions ORDER BY deal_id`
    );
    expect(restoredComms.rows).toEqual([
      { deal_id: 11, status: 'PARTIALLY_PAID', paid_amount_minor: 50000 },
      { deal_id: 12, status: 'PAID', paid_amount_minor: 150000 },
    ]);
  });
});
