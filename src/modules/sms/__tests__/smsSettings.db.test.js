import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE TABLE users(id integer PRIMARY KEY);
 CREATE TABLE leads(id integer PRIMARY KEY,birth_date text,archived_at text);
 CREATE TABLE deals(id integer PRIMARY KEY,lead_id integer,status text,final_price_minor integer,unit_id integer,reservation_expires_at text);
 CREATE TABLE payments(id integer PRIMARY KEY,deal_id integer,status text,operation_type text,amount_minor integer);
 CREATE TABLE deal_payment_schedules(id integer PRIMARY KEY,deal_id integer,amount_minor integer,paid_amount_minor integer,due_date text);
 CREATE TABLE sms_templates(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,code text UNIQUE,name text,text text,is_active boolean DEFAULT true,updated_at timestamptz DEFAULT now());
 INSERT INTO sms_templates(code,name,text) VALUES('PAYMENT_RECEIVED','payment','payment'),('PAYMENT_REMINDER','reminder','reminder'),('DEBTOR_REMINDER','debt','debt');
 CREATE TABLE sms_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,event_type text,idempotency_key text UNIQUE,mode text,client_id integer,deal_id integer,payment_id integer,template_code text,payload_json jsonb,created_at timestamptz DEFAULT now(),status text DEFAULT 'AWAITING_CONFIRMATION');
 INSERT INTO users VALUES(1);INSERT INTO leads VALUES(1,to_char((now() AT TIME ZONE 'Asia/Dushanbe')::date,'YYYY-MM-DD'),NULL);
 `);
  await db.exec(
    readFileSync(
      new URL(
        "../../../db/migrations/20261008195700_sms_notification_settings.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
afterAll(async () => db.close());
describe.sequential("configured SMS lifecycle queue, no provider", () => {
  it("keeps legacy reminders enabled and every new rule off", async () => {
    const rows = (await db.query("SELECT * FROM sms_notification_rules")).rows;
    expect(rows.filter((r) => r.enabled).map((r) => r.event_type)).toEqual([
      "PAYMENT_REMINDER",
    ]);
    expect(
      rows.find((r) => r.event_type === "PAYMENT_REMINDER").offset_days,
    ).toBe(3);
  });
  it("keeps configuration and audit private", async () => {
    await db.exec("SET ROLE anon");
    try {
      await expect(
        db.query("SELECT * FROM sms_notification_rules"),
      ).rejects.toThrow();
      await expect(
        db.query("SELECT queue_daily_configured_sms()"),
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT has_schema_privilege('anon','tozon_internal','usage') AS allowed",
          )
        ).rows[0].allowed,
      ).toBe(false);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
  it("creates no lifecycle queue for disabled rules", async () => {
    await db.exec(
      "INSERT INTO deals VALUES(1,1,'RESERVED',10000,1,to_char(current_date+1,'YYYY-MM-DD'))",
    );
    expect((await db.query("SELECT * FROM sms_events")).rows).toHaveLength(0);
  });
  it("records setting revisions and creates one signing event", async () => {
    await db.exec(
      "UPDATE sms_notification_rules SET enabled=true,version=version+1 WHERE event_type='CONTRACT_CREATED'; UPDATE deals SET status='SIGNED' WHERE id=1;UPDATE deals SET status='SIGNED' WHERE id=1;",
    );
    expect(
      (
        await db.query(
          "SELECT * FROM sms_events WHERE event_type='CONTRACT_CREATED'",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("SELECT * FROM sms_settings_history")).rows.length,
    ).toBeGreaterThan(0);
  });
  it("deduplicates changed schedules in one transaction", async () => {
    await db.exec(
      "UPDATE sms_notification_rules SET enabled=true WHERE event_type='SCHEDULE_CHANGED';INSERT INTO deal_payment_schedules VALUES(1,1,5000,0,'2026-12-01'),(2,1,5000,0,'2027-01-01');BEGIN;UPDATE deal_payment_schedules SET amount_minor=4000 WHERE deal_id=1;COMMIT;",
    );
    expect(
      (
        await db.query(
          "SELECT * FROM sms_events WHERE event_type='SCHEDULE_CHANGED'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("queues payment, full payment and void events using real STANDARD payments", async () => {
    await db.exec(
      "UPDATE sms_notification_rules SET enabled=true WHERE event_type IN ('PAYMENT_RECEIVED','PAYMENT_CANCELLED','CONTRACT_PAID');INSERT INTO payments VALUES(1,1,'POSTED','STANDARD',10000);UPDATE payments SET status='VOIDED' WHERE id=1;",
    );
    const events = (
      await db.query(
        "SELECT * FROM sms_events WHERE payment_id=1 OR event_type='CONTRACT_PAID'",
      )
    ).rows;
    expect(events.map((e) => e.event_type).sort()).toEqual([
      "CONTRACT_PAID",
      "PAYMENT_CANCELLED",
      "PAYMENT_RECEIVED",
    ]);
    expect(
      events.every((e) => e.mode === "CONFIRM" && e.payload_json.managed_rule),
    ).toBe(true);
  });
  it("does not queue internal transfers as customer payments", async () => {
    await db.exec(
      "INSERT INTO payments VALUES(2,1,'POSTED','INTERNAL_CASH_TRANSFER',10000)",
    );
    expect(
      (await db.query("SELECT * FROM sms_events WHERE payment_id=2")).rows,
    ).toHaveLength(0);
  });
  it("only queues one birthday per year and does not modify financial rows", async () => {
    await db.exec(
      "UPDATE sms_notification_rules SET enabled=true WHERE event_type='BIRTHDAY'",
    );
    const before = (await db.query("SELECT * FROM deals")).rows;
    await db.query("SELECT queue_daily_configured_sms()");
    await db.query("SELECT queue_daily_configured_sms()");
    expect(
      (await db.query("SELECT * FROM sms_events WHERE event_type='BIRTHDAY'"))
        .rows,
    ).toHaveLength(1);
    expect((await db.query("SELECT * FROM deals")).rows).toEqual(before);
  });
  it("refuses AUTO modes for new rules", async () => {
    await expect(
      db.query(
        "UPDATE sms_notification_rules SET mode='INHERIT' WHERE event_type='BIRTHDAY'",
      ),
    ).rejects.toThrow();
  });
  it("inactive templates prevent new events", async () => {
    await db.exec(
      "UPDATE sms_templates SET is_active=false WHERE code='PAYMENT_RECEIVED'; INSERT INTO payments VALUES(3,1,'POSTED','STANDARD',50)",
    );
    expect(
      (
        await db.query(
          "SELECT * FROM sms_events WHERE payment_id=3 AND event_type='PAYMENT_RECEIVED'",
        )
      ).rows,
    ).toHaveLength(0);
  });
});
