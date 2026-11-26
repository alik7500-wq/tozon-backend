-- Test-pilot compatibility for the preserved legacy export. No data import or trigger changes.
BEGIN;
CREATE TABLE public."marketing_partners" (
 "id" bigserial NOT NULL,
 "legacy_dictionary_id" text,
 "name" text NOT NULL,
 "contact_person" text,
 "phone" text,
 "is_active" boolean DEFAULT true NOT NULL,
 "commission_type" text DEFAULT 'NONE'::text NOT NULL,
 "commission_rate_bp" integer DEFAULT 0 NOT NULL,
 "commission_fixed_minor" bigint DEFAULT 0 NOT NULL,
 "commission_terms" text,
 "cooperation_start_date" date,
 "notes" text,
 "created_by" bigint,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public."marketing_partners" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."marketing_partners" FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."marketing_partners" TO service_role;
CREATE TABLE public."marketing_commissions" (
 "id" bigserial NOT NULL,
 "deal_id" bigint NOT NULL,
 "partner_id" bigint,
 "contract_price_minor" bigint DEFAULT 0 NOT NULL,
 "commission_type" text DEFAULT 'NONE'::text NOT NULL,
 "commission_rate_bp" integer DEFAULT 0 NOT NULL,
 "calculated_amount_minor" bigint DEFAULT 0 NOT NULL,
 "approved_amount_minor" bigint DEFAULT 0 NOT NULL,
 "paid_amount_minor" bigint DEFAULT 0 NOT NULL,
 "status" text DEFAULT 'NOT_CALCULATED'::text NOT NULL,
 "accrued_at" timestamp with time zone,
 "approved_at" timestamp with time zone,
 "approved_by" bigint,
 "paid_at" timestamp with time zone,
 "cancelled_at" timestamp with time zone,
 "cancel_reason" text,
 "notes" text,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public."marketing_commissions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."marketing_commissions" FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."marketing_commissions" TO service_role;
CREATE TABLE public."deal_source_history" (
 "id" bigserial NOT NULL,
 "deal_id" bigint NOT NULL,
 "old_source" text,
 "new_source" text NOT NULL,
 "old_partner_id" bigint,
 "new_partner_id" bigint,
 "old_marketer_name" text,
 "new_marketer_name" text,
 "reason" text,
 "changed_by" bigint,
 "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public."deal_source_history" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."deal_source_history" FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."deal_source_history" TO service_role;
CREATE TABLE public."unit_status_history" (
 "id" bigserial NOT NULL,
 "unit_id" bigint NOT NULL,
 "old_status" text,
 "new_status" text NOT NULL,
 "deal_id" bigint,
 "reason" text,
 "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
 "changed_by" bigint
);
ALTER TABLE public."unit_status_history" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."unit_status_history" FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."unit_status_history" TO service_role;
ALTER TABLE public."deal_source_history" ADD CONSTRAINT "deal_source_history_new_source_check" CHECK ((new_source = ANY (ARRAY['UNSPECIFIED'::text, 'DIRECT'::text, 'MARKETER'::text])));
ALTER TABLE public."deal_source_history" ADD CONSTRAINT "deal_source_history_pkey" PRIMARY KEY (id);
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "chk_marketing_commissions_paid_le_approved" CHECK (((paid_amount_minor <= approved_amount_minor) OR (status = 'CANCELLED'::text)));
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_approved_amount_minor_check" CHECK ((approved_amount_minor >= 0));
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_calculated_amount_minor_check" CHECK ((calculated_amount_minor >= 0));
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_commission_rate_bp_check" CHECK (((commission_rate_bp >= 0) AND (commission_rate_bp <= 10000)));
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_commission_type_check" CHECK ((commission_type = ANY (ARRAY['NONE'::text, 'PERCENT'::text, 'FIXED_USD'::text])));
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_contract_price_minor_check" CHECK ((contract_price_minor >= 0));
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_deal_id_key" UNIQUE (deal_id);
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_paid_amount_minor_check" CHECK ((paid_amount_minor >= 0));
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_pkey" PRIMARY KEY (id);
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_status_check" CHECK ((status = ANY (ARRAY['NOT_CALCULATED'::text, 'CALCULATED'::text, 'PENDING_APPROVAL'::text, 'APPROVED'::text, 'PARTIALLY_PAID'::text, 'PAID'::text, 'CANCELLED'::text])));
ALTER TABLE public."marketing_partners" ADD CONSTRAINT "chk_marketing_partners_commission_type" CHECK ((commission_type = ANY (ARRAY['NONE'::text, 'PERCENT'::text, 'FIXED_USD'::text])));
ALTER TABLE public."marketing_partners" ADD CONSTRAINT "chk_marketing_partners_fixed_minor" CHECK ((commission_fixed_minor >= 0));
ALTER TABLE public."marketing_partners" ADD CONSTRAINT "chk_marketing_partners_rate_bp" CHECK (((commission_rate_bp >= 0) AND (commission_rate_bp <= 10000)));
ALTER TABLE public."marketing_partners" ADD CONSTRAINT "marketing_partners_legacy_dictionary_id_key" UNIQUE (legacy_dictionary_id);
ALTER TABLE public."marketing_partners" ADD CONSTRAINT "marketing_partners_name_key" UNIQUE (name);
ALTER TABLE public."marketing_partners" ADD CONSTRAINT "marketing_partners_pkey" PRIMARY KEY (id);
ALTER TABLE public."unit_status_history" ADD CONSTRAINT "unit_status_history_pkey" PRIMARY KEY (id);
ALTER TABLE public."buildings" ADD COLUMN "footprint_area_m2_x100" integer;
ALTER TABLE public."buildings" ADD COLUMN "gross_floor_area_m2_x100" integer;
ALTER TABLE public."crm_document_settings" ADD COLUMN "buyer_manager_contacts" jsonb;
ALTER TABLE public."deals" ADD COLUMN "sales_source" text;
ALTER TABLE public."deals" ADD COLUMN "marketing_partner_id" bigint;
ALTER TABLE public."deals" ADD COLUMN "marketer_name" text;
ALTER TABLE public."deals" ADD COLUMN "source_confirmed_by" bigint;
ALTER TABLE public."deals" ADD COLUMN "source_confirmed_at" timestamp with time zone;
ALTER TABLE public."deals" ADD COLUMN "reserved_at" timestamp with time zone;
ALTER TABLE public."leads" ADD COLUMN "sms_language" text;
ALTER TABLE public."deal_source_history" ADD CONSTRAINT "deal_source_history_changed_by_fkey" FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public."deal_source_history" ADD CONSTRAINT "deal_source_history_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE public."deal_source_history" ADD CONSTRAINT "deal_source_history_new_partner_id_fkey" FOREIGN KEY (new_partner_id) REFERENCES marketing_partners(id) ON DELETE SET NULL;
ALTER TABLE public."deal_source_history" ADD CONSTRAINT "deal_source_history_old_partner_id_fkey" FOREIGN KEY (old_partner_id) REFERENCES marketing_partners(id) ON DELETE SET NULL;
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_approved_by_fkey" FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE public."marketing_commissions" ADD CONSTRAINT "marketing_commissions_partner_id_fkey" FOREIGN KEY (partner_id) REFERENCES marketing_partners(id) ON DELETE RESTRICT;
ALTER TABLE public."marketing_partners" ADD CONSTRAINT "marketing_partners_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public."unit_status_history" ADD CONSTRAINT "unit_status_history_changed_by_fkey" FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public."unit_status_history" ADD CONSTRAINT "unit_status_history_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE public."unit_status_history" ADD CONSTRAINT "unit_status_history_unit_id_fkey" FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE;
CREATE SCHEMA tozon_import;
REVOKE ALL ON SCHEMA tozon_import FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE tozon_import.batches(id uuid PRIMARY KEY,source_ref text NOT NULL,snapshot_at timestamptz NOT NULL,description text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tozon_import.rows(batch_id uuid NOT NULL REFERENCES tozon_import.batches(id),table_name text NOT NULL,source_id text NOT NULL,target_id text NOT NULL,payload_hash text NOT NULL,PRIMARY KEY(batch_id,table_name,source_id),UNIQUE(table_name,target_id));
ALTER TABLE tozon_import.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tozon_import.rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA tozon_import FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE,SELECT ON SEQUENCE public.marketing_partners_id_seq,public.marketing_commissions_id_seq,public.deal_source_history_id_seq,public.unit_status_history_id_seq TO service_role;
COMMIT;
