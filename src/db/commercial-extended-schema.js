// Generated from reviewed, schema-only catalog snapshots by scripts/commercial/build-extended-schema.py.
// Immutable once applied. Do not import production records or historical repair migrations.
export const commercialExtendedSchema = String.raw`-- Schema-only reconciliation. No production records, sequence values or grants.
SET LOCAL search_path = public, tozon_internal, pg_catalog;
CREATE SCHEMA tozon_internal;
REVOKE ALL ON SCHEMA tozon_internal FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA tozon_internal TO service_role;
CREATE TABLE "public"."barter_realization_results" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "result_cash_desk_id" uuid NOT NULL,
 "source_cash_desk_id" uuid NOT NULL,
 "purchase_payment_id" integer NOT NULL,
 "sale_transfer_id" uuid NOT NULL,
 "reclassified_transfer_id" uuid NOT NULL,
 "reclassified_payment_id" integer NOT NULL,
 "reclassified_expense_id" integer NOT NULL,
 "asset_name" text NOT NULL,
 "realization_date" date NOT NULL,
 "cost_tjs_minor" bigint NOT NULL,
 "proceeds_tjs_minor" bigint NOT NULL,
 "selling_cost_tjs_minor" bigint DEFAULT 0 NOT NULL,
 "exchange_rate" numeric NOT NULL,
 "result_tjs_minor" bigint GENERATED ALWAYS AS (((proceeds_tjs_minor - cost_tjs_minor) - selling_cost_tjs_minor)) STORED,
 "result_usd_minor" bigint GENERATED ALWAYS AS ((round(((((proceeds_tjs_minor - cost_tjs_minor) - selling_cost_tjs_minor))::numeric / exchange_rate)))::bigint) STORED,
 "source_currency" text NOT NULL,
 "status" text DEFAULT 'ACTIVE'::text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "created_by" integer NOT NULL,
 "source_snapshot" jsonb NOT NULL
);
CREATE TABLE "public"."cash_transfers" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "operation_type" character varying(32) DEFAULT 'INTERNAL_CASH_TRANSFER'::character varying NOT NULL,
 "source_cash_desk_id" uuid NOT NULL,
 "destination_cash_desk_id" uuid NOT NULL,
 "source_expense_id" integer,
 "destination_payment_id" integer,
 "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
 "amount_minor" bigint NOT NULL,
 "amount_tjs" numeric(14,2),
 "amount_usd" numeric(14,2) NOT NULL,
 "exchange_rate" numeric(12,6),
 "recipient" character varying(255),
 "description" text,
 "status" character varying(32) DEFAULT 'ACTIVE'::character varying NOT NULL,
 "void_reason" text,
 "voided_at" timestamp with time zone,
 "voided_by" integer,
 "idempotency_key" character varying(128),
 "created_by" integer,
 "created_at" timestamp with time zone DEFAULT now()
);
CREATE TABLE "public"."construction_documents" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "number" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "kind" text NOT NULL,
 "doc_date" date NOT NULL,
 "due_date" date,
 "currency" text NOT NULL,
 "exchange_rate" numeric(14,6),
 "warehouse_id" uuid,
 "destination_id" uuid,
 "party_id" uuid,
 "project_id" integer,
 "work_type" text,
 "basis" text NOT NULL,
 "balance_type" text,
 "amount" numeric(18,2),
 "lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
 "expense_id" integer,
 "payment_id" integer,
 "status" text DEFAULT 'DRAFT'::text NOT NULL,
 "created_by" integer NOT NULL,
 "posted_by" integer,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "posted_at" timestamp with time zone
);
CREATE TABLE "public"."construction_expense_settlement_audit" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "expense_id" integer NOT NULL,
 "actor_id" integer,
 "operation" text NOT NULL,
 "before_data" jsonb,
 "after_data" jsonb,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."construction_materials" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "name" text NOT NULL,
 "unit" text NOT NULL,
 "category" text,
 "active" boolean DEFAULT true NOT NULL
);
CREATE TABLE "public"."construction_parties" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "name" text NOT NULL,
 "kind" text NOT NULL,
 "user_id" integer,
 "active" boolean DEFAULT true NOT NULL
);
CREATE TABLE "public"."construction_price_corrections" (
 "id" uuid NOT NULL,
 "receipt_id" uuid NOT NULL,
 "version" integer NOT NULL,
 "reason" text NOT NULL,
 "actor_id" integer NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "before_lines" jsonb NOT NULL,
 "after_lines" jsonb NOT NULL,
 "ledger_changes" jsonb NOT NULL
);
CREATE TABLE "public"."construction_report_receipts" (
 "receipt_id" uuid NOT NULL,
 "report_id" uuid NOT NULL
);
CREATE TABLE "public"."construction_settings" (
 "id" integer NOT NULL,
 "start_date" date NOT NULL,
 "approver_user_id" integer,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."construction_settlement_entries" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "document_id" uuid NOT NULL,
 "party_id" uuid NOT NULL,
 "currency" text NOT NULL,
 "account" text NOT NULL,
 "amount" numeric(18,2) NOT NULL
);
CREATE TABLE "public"."construction_stock_entries" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "document_id" uuid NOT NULL,
 "warehouse_id" uuid NOT NULL,
 "material_id" uuid NOT NULL,
 "currency" text NOT NULL,
 "quantity" numeric(18,4) NOT NULL,
 "value" numeric(18,2) NOT NULL
);
CREATE TABLE "public"."construction_warehouses" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "name" text NOT NULL,
 "responsible_id" uuid,
 "active" boolean DEFAULT true NOT NULL
);
CREATE TABLE "public"."cost_audit" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "entity" text NOT NULL,
 "entity_id" integer NOT NULL,
 "before_data" jsonb,
 "after_data" jsonb,
 "actor_id" integer NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."cost_building_bases" (
 "building_id" integer NOT NULL,
 "sellable_area_m2" numeric(14,2) NOT NULL,
 "reason" text NOT NULL,
 "version" integer DEFAULT 1 NOT NULL,
 "updated_by" integer NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."cost_expense_allocations" (
 "expense_id" integer NOT NULL,
 "mode" text NOT NULL,
 "shares" jsonb DEFAULT '[]'::jsonb NOT NULL,
 "reason" text NOT NULL,
 "version" integer DEFAULT 1 NOT NULL,
 "updated_by" integer NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."cost_material_audit" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "entity" text NOT NULL,
 "entity_id" uuid NOT NULL,
 "before_data" jsonb,
 "after_data" jsonb,
 "actor_id" integer NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."cost_material_payment_links" (
 "id" uuid NOT NULL,
 "usage_id" uuid NOT NULL,
 "expense_id" integer NOT NULL,
 "paid_amount" numeric(18,2) NOT NULL,
 "cash_usd_minor" bigint NOT NULL,
 "reason" text NOT NULL,
 "status" text DEFAULT 'ACTIVE'::text NOT NULL,
 "version" integer DEFAULT 1 NOT NULL,
 "updated_by" integer NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."cost_material_usages" (
 "id" uuid NOT NULL,
 "stock_entry_id" bigint,
 "building_id" integer NOT NULL,
 "material_kind" text NOT NULL,
 "usage_date" date NOT NULL,
 "quantity" numeric(18,4) NOT NULL,
 "unit" text NOT NULL,
 "amount" numeric(18,2) NOT NULL,
 "currency" text NOT NULL,
 "exchange_rate" numeric(14,6),
 "reason" text NOT NULL,
 "status" text DEFAULT 'ACTIVE'::text NOT NULL,
 "version" integer DEFAULT 1 NOT NULL,
 "updated_by" integer NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."crm_document_settings" (
 "id" integer NOT NULL,
 "version" integer DEFAULT 1 NOT NULL,
 "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_by" bigint
);
CREATE TABLE "public"."crm_document_settings_history" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "version" integer NOT NULL,
 "data" jsonb NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "created_by" bigint
);
CREATE TABLE "public"."crm_document_templates" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "kind" text NOT NULL,
 "language" text NOT NULL,
 "scope" text DEFAULT '*'::text NOT NULL,
 "name" text NOT NULL,
 "file_base64" text NOT NULL,
 "file_size" integer NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "created_by" bigint NOT NULL,
 "active" boolean DEFAULT false NOT NULL
);
CREATE TABLE "public"."crm_roles" (
 "code" text NOT NULL,
 "name" text NOT NULL,
 "description" text DEFAULT ''::text NOT NULL,
 "permissions" jsonb DEFAULT '["access.v2"]'::jsonb NOT NULL,
 "is_system" boolean DEFAULT false NOT NULL,
 "is_active" boolean DEFAULT true NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."deal_audit_logs" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "deal_id" bigint,
 "user_id" bigint,
 "action" character varying(50) NOT NULL,
 "changes_json" jsonb NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "public"."deals" ALTER COLUMN "barter_amount_minor" DROP NOT NULL;
ALTER TABLE "public"."deals" ADD COLUMN "deal_price_per_m2_minor" bigint;
ALTER TABLE "public"."deals" ADD COLUMN "exchange_rate" numeric(10,4);
ALTER TABLE "public"."deals" ADD COLUMN "paid_at_termination_minor" bigint DEFAULT 0;
ALTER TABLE "public"."deals" ADD COLUMN "refund_amount_minor" bigint DEFAULT 0;
ALTER TABLE "public"."deals" ADD COLUMN "retained_amount_minor" bigint DEFAULT 0;
ALTER TABLE "public"."deals" ADD COLUMN "refund_expense_id" bigint;
ALTER TABLE "public"."deals" ADD COLUMN "terminated_by_user_id" bigint;
ALTER TABLE "public"."deals" ADD COLUMN "first_payment_date" text;
ALTER TABLE "public"."deals" ADD COLUMN "installment_interval_months" integer DEFAULT 1 NOT NULL;
ALTER TABLE "public"."deals" ADD COLUMN "vehicle_details" jsonb;
ALTER TABLE "public"."deals" ADD COLUMN "discount_snapshot" jsonb;
CREATE TABLE "public"."dictionaries" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "type" character varying(50) NOT NULL,
 "name" character varying(255) NOT NULL,
 "code" character varying(100),
 "color" character varying(50),
 "icon" character varying(50),
 "sort_order" integer DEFAULT 0,
 "is_active" boolean DEFAULT true,
 "is_system" boolean DEFAULT false,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now()
);
CREATE TABLE "public"."discount_schemes" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "project_id" integer NOT NULL,
 "name" text NOT NULL,
 "rules" jsonb NOT NULL,
 "is_active" boolean DEFAULT true NOT NULL,
 "starts_on" date,
 "ends_on" date,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."expenses" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "amount_minor" integer NOT NULL,
 "expense_date" date NOT NULL,
 "category" text NOT NULL,
 "description" text,
 "created_by_user_id" integer,
 "created_at" timestamp with time zone DEFAULT now(),
 "currency" text DEFAULT 'USD'::text NOT NULL,
 "method" text DEFAULT 'CASH'::text NOT NULL,
 "reference" text,
 "recipient" text,
 "exchange_rate" numeric(12,6),
 "amount_usd" numeric(14,2),
 "conversion_expense_id" integer,
 "cash_desk_id" uuid,
 "transfer_id" uuid,
 "status" character varying(32) DEFAULT 'ACTIVE'::character varying NOT NULL,
 "void_reason" text,
 "voided_at" timestamp with time zone,
 "voided_by" integer,
 "operation_type" character varying(32) DEFAULT 'STANDARD'::character varying,
 "amount_tjs" numeric(14,2),
 "idempotency_key" character varying(128),
 "conversion_id" uuid,
 "settlement_method" character varying(30) DEFAULT 'CASH'::character varying,
 "deal_id" bigint,
 "document_number" text,
 "settlement_party_id" uuid,
 "settlement_account" text,
 "settlement_updated_by" integer
);
CREATE TABLE "public"."finance_audit_backups" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "batch_id" character varying(64) NOT NULL,
 "table_name" character varying(64) NOT NULL,
 "record_id" integer NOT NULL,
 "document_number" character varying(128),
 "amount_minor" bigint,
 "currency" character varying(3),
 "exchange_rate" numeric(12,6),
 "cash_desk_name" character varying(255),
 "document_date" date,
 "previous_status" character varying(32),
 "description" text,
 "full_snapshot" jsonb NOT NULL,
 "backed_up_at" timestamp with time zone DEFAULT now(),
 "backed_up_by" character varying(64)
);
CREATE TABLE "public"."identity_documents" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "lead_id" bigint,
 "deal_id" bigint,
 "project_id" bigint,
 "document_type" text DEFAULT 'PASSPORT_TJ'::text NOT NULL,
 "front_image_path" text,
 "back_image_path" text,
 "ocr_raw_json" text,
 "ocr_fields_json" text,
 "mrz_data_json" text,
 "confidence_score" real DEFAULT 0.0,
 "warnings_json" text,
 "status" text DEFAULT 'REVIEW_REQUIRED'::text NOT NULL,
 "verified_data_json" text,
 "verified_by_user_id" bigint,
 "verified_at" timestamp with time zone,
 "created_by_user_id" bigint,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."layout_features" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "layout_type_id" integer NOT NULL,
 "icon_key" text DEFAULT 'Sparkles'::text NOT NULL,
 "text_ru" text NOT NULL,
 "text_tg" text,
 "sort_order" integer DEFAULT 0 NOT NULL,
 "is_active" boolean DEFAULT true NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
CREATE TABLE "public"."layout_rooms" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "layout_type_id" integer NOT NULL,
 "room_number" integer NOT NULL,
 "room_type" text DEFAULT 'ROOM'::text NOT NULL,
 "name_ru" text NOT NULL,
 "name_tg" text,
 "area" numeric,
 "description_ru" text,
 "description_tg" text,
 "floor_finish_ru" text,
 "floor_finish_tg" text,
 "wall_finish_ru" text,
 "wall_finish_tg" text,
 "ceiling_finish_ru" text,
 "ceiling_finish_tg" text,
 "lighting_ru" text,
 "lighting_tg" text,
 "ventilation_ru" text,
 "ventilation_tg" text,
 "position_x_percent" numeric NOT NULL,
 "position_y_percent" numeric NOT NULL,
 "polygon_points" jsonb,
 "sort_order" integer DEFAULT 0 NOT NULL,
 "is_active" boolean DEFAULT true NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
ALTER TABLE "public"."layout_types" ADD COLUMN "name_tg" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "description_ru" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "description_tg" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "furnished_plan_path" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "technical_plan_path" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "living_area" numeric;
ALTER TABLE "public"."layout_types" ADD COLUMN "kitchen_area" numeric;
ALTER TABLE "public"."layout_types" ADD COLUMN "ceiling_height" numeric;
ALTER TABLE "public"."layout_types" ADD COLUMN "bathrooms_count" integer;
ALTER TABLE "public"."layout_types" ADD COLUMN "windows_count" integer;
ALTER TABLE "public"."layout_types" ADD COLUMN "doors_count" integer;
ALTER TABLE "public"."layout_types" ADD COLUMN "balconies_count" integer;
ALTER TABLE "public"."layout_types" ADD COLUMN "heating_type_ru" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "heating_type_tg" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "ventilation_type_ru" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "ventilation_type_tg" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "orientation_ru" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "orientation_tg" text;
ALTER TABLE "public"."layout_types" ADD COLUMN "is_published" boolean DEFAULT true NOT NULL;
ALTER TABLE "public"."layout_types" ADD COLUMN "gallery_images" jsonb DEFAULT '[]'::jsonb NOT NULL;
CREATE TABLE "public"."lead_assignment_history" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "lead_id" bigint NOT NULL,
 "from_user_id" bigint,
 "to_user_id" bigint,
 "assigned_by_user_id" bigint,
 "assignment_type" character varying(50) DEFAULT 'MANUAL'::character varying NOT NULL,
 "reason" text,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."lead_distribution_settings" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "enabled" boolean DEFAULT false NOT NULL,
 "algorithm" character varying(50) DEFAULT 'LEAST_LOADED'::character varying NOT NULL,
 "max_open_leads_per_rep" integer DEFAULT 25 NOT NULL,
 "excluded_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
 "working_hours_only" boolean DEFAULT true NOT NULL,
 "auto_reassign_on_stagnant" boolean DEFAULT false NOT NULL,
 "updated_by_user_id" bigint,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."lead_interested_units" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "lead_id" bigint NOT NULL,
 "unit_id" bigint NOT NULL,
 "priority" character varying(20) DEFAULT 'MEDIUM'::character varying NOT NULL,
 "comment" text,
 "next_contact_date" date,
 "created_by_user_id" bigint,
 "created_at" timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
 "updated_at" timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE TABLE "public"."lead_status_history" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "lead_id" bigint NOT NULL,
 "from_status" character varying(50),
 "to_status" character varying(50) NOT NULL,
 "changed_by_user_id" bigint,
 "lost_reason" character varying(100),
 "comment" text,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "public"."leads" ADD COLUMN "assigned_at" timestamp with time zone;
ALTER TABLE "public"."leads" ADD COLUMN "first_contact_at" timestamp with time zone;
ALTER TABLE "public"."leads" ADD COLUMN "first_contact_by_user_id" bigint;
ALTER TABLE "public"."leads" ADD COLUMN "first_contact_outcome" character varying(50);
ALTER TABLE "public"."leads" ADD COLUMN "reassignment_reason" text;
ALTER TABLE "public"."leads" ADD COLUMN "idempotency_key" character varying(255);
CREATE TABLE "public"."panorama_360" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "tour_id" integer NOT NULL,
 "name" text NOT NULL,
 "storage_path" text NOT NULL,
 "thumbnail_path" text,
 "entity_type" text,
 "entity_id" integer,
 "initial_yaw" numeric DEFAULT 0 NOT NULL,
 "initial_pitch" numeric DEFAULT 0 NOT NULL,
 "initial_fov" numeric DEFAULT 75 NOT NULL,
 "sort_order" integer DEFAULT 0 NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
CREATE TABLE "public"."panorama_hotspots" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "panorama_id" integer NOT NULL,
 "hotspot_type" text NOT NULL,
 "yaw" numeric NOT NULL,
 "pitch" numeric NOT NULL,
 "label" text,
 "target_panorama_id" integer,
 "target_entity_type" text,
 "target_entity_id" integer,
 "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
CREATE TABLE "public"."passport_ai_audit_logs" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "user_id" bigint,
 "client_id" bigint,
 "event_type" character varying(50) NOT NULL,
 "document_country" character varying(10),
 "document_type" character varying(50),
 "success" boolean DEFAULT true NOT NULL,
 "model" character varying(100),
 "processing_duration_ms" integer,
 "warnings_count" integer DEFAULT 0,
 "conflicts_count" integer DEFAULT 0,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "public"."payments" ALTER COLUMN "deal_id" DROP NOT NULL;
ALTER TABLE "public"."payments" ADD COLUMN "currency" text DEFAULT 'USD'::text;
ALTER TABLE "public"."payments" ADD COLUMN "payer_name" text;
ALTER TABLE "public"."payments" ADD COLUMN "cash_desk_id" uuid;
ALTER TABLE "public"."payments" ADD COLUMN "transfer_id" uuid;
ALTER TABLE "public"."payments" ADD COLUMN "status" character varying(32) DEFAULT 'ACTIVE'::character varying NOT NULL;
ALTER TABLE "public"."payments" ADD COLUMN "void_reason" text;
ALTER TABLE "public"."payments" ADD COLUMN "voided_at" timestamp with time zone;
ALTER TABLE "public"."payments" ADD COLUMN "voided_by" integer;
ALTER TABLE "public"."payments" ADD COLUMN "operation_type" character varying(32) DEFAULT 'STANDARD'::character varying;
ALTER TABLE "public"."payments" ADD COLUMN "amount_tjs" numeric(14,2);
ALTER TABLE "public"."payments" ADD COLUMN "amount_usd" numeric(14,2);
ALTER TABLE "public"."payments" ADD COLUMN "exchange_rate" numeric(12,6);
ALTER TABLE "public"."payments" ADD COLUMN "idempotency_key" character varying;
ALTER TABLE "public"."payments" ADD COLUMN "conversion_id" uuid;
ALTER TABLE "public"."payments" ADD COLUMN "settlement_method" character varying(30) DEFAULT 'CASH'::character varying;
ALTER TABLE "public"."payments" ADD COLUMN "document_number" text;
ALTER TABLE "public"."payments" ADD COLUMN "customer_pko_number" bigint;
CREATE TABLE "public"."project_media" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "project_id" integer NOT NULL,
 "category" text NOT NULL,
 "title" text NOT NULL,
 "description" text,
 "storage_path" text NOT NULL,
 "mime_type" text DEFAULT 'image/jpeg'::text NOT NULL,
 "sort_order" integer DEFAULT 0 NOT NULL,
 "is_cover" boolean DEFAULT false NOT NULL,
 "is_active" boolean DEFAULT true NOT NULL,
 "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
CREATE TABLE "public"."sales_plan_alert_settings" (
 "id" smallint DEFAULT 1 NOT NULL,
 "behind_schedule_threshold_pp" numeric(4,1) DEFAULT 15.0 NOT NULL,
 "at_risk_forecast_threshold_pct" numeric(4,1) DEFAULT 80.0 NOT NULL,
 "min_elapsed_working_days" smallint DEFAULT 3 NOT NULL,
 "notify_achieved_enabled" boolean DEFAULT true NOT NULL,
 "weekly_digest_enabled" boolean DEFAULT true NOT NULL,
 "weekly_digest_day_of_week" smallint DEFAULT 1 NOT NULL,
 "weekly_digest_hour" smallint DEFAULT 9 NOT NULL,
 "updated_by" bigint,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."sales_plan_audit_logs" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "sales_plan_id" bigint NOT NULL,
 "action" character varying(50) NOT NULL,
 "old_values" jsonb,
 "new_values" jsonb NOT NULL,
 "reason" text NOT NULL,
 "changed_by_user_id" bigint,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."sales_plans" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "period" character varying(7) NOT NULL,
 "scope_type" character varying(20) NOT NULL,
 "manager_id" bigint,
 "project_id" bigint,
 "building_id" bigint,
 "target_deals_count" integer DEFAULT 0 NOT NULL,
 "target_volume_minor" bigint DEFAULT 0 NOT NULL,
 "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
 "status" character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
 "created_by" bigint,
 "approved_by" bigint,
 "approved_at" timestamp with time zone,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."scene_3d" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "project_id" integer NOT NULL,
 "building_id" integer,
 "name" text NOT NULL,
 "scene_type" text NOT NULL,
 "storage_path" text NOT NULL,
 "file_size_bytes" bigint DEFAULT 0,
 "version" integer DEFAULT 1 NOT NULL,
 "is_active" boolean DEFAULT true NOT NULL,
 "camera_config" jsonb DEFAULT '{"fov": 45, "target": [0, 0, 0], "position": [30, 20, 30]}'::jsonb NOT NULL,
 "environment_config" jsonb DEFAULT '{"preset": "city", "exposure": 1.0, "background_color": "#0f172a"}'::jsonb NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
CREATE TABLE "public"."scene_3d_entities" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "scene_id" integer NOT NULL,
 "mesh_key" text NOT NULL,
 "entity_type" text NOT NULL,
 "entity_id" integer NOT NULL,
 "interaction_type" text DEFAULT 'SELECT'::text NOT NULL,
 "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
CREATE TABLE "public"."sms_events" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "event_type" character varying(50) NOT NULL,
 "idempotency_key" character varying(150) NOT NULL,
 "mode" character varying(20) DEFAULT 'CONFIRM'::character varying NOT NULL,
 "status" character varying(30) DEFAULT 'AWAITING_CONFIRMATION'::character varying NOT NULL,
 "client_id" integer,
 "deal_id" integer,
 "payment_id" integer,
 "schedule_id" integer,
 "task_id" integer,
 "template_code" character varying(50) NOT NULL,
 "payload_json" jsonb DEFAULT '{}'::jsonb,
 "scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
 "available_at" timestamp with time zone DEFAULT now() NOT NULL,
 "confirmed_by" integer,
 "confirmed_at" timestamp with time zone,
 "cancelled_by" integer,
 "cancelled_at" timestamp with time zone,
 "cancel_reason" text,
 "failure_code" character varying(50),
 "failure_message" text,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."sms_messages" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "client_id" bigint,
 "deal_id" bigint,
 "contract_id" bigint,
 "phone" text NOT NULL,
 "message" text NOT NULL,
 "provider" text DEFAULT 'PAYOM'::text NOT NULL,
 "sender_name" text NOT NULL,
 "provider_message_id" text,
 "status" text DEFAULT 'queued'::text NOT NULL,
 "error_code" text,
 "error_message" text,
 "created_by" bigint,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "sent_at" timestamp with time zone,
 "delivered_at" timestamp with time zone,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "payment_id" integer,
 "event_id" bigint
);
CREATE TABLE "public"."sms_notification_rules" (
 "event_type" text NOT NULL,
 "group_name" text NOT NULL,
 "name" text NOT NULL,
 "template_code" text NOT NULL,
 "enabled" boolean DEFAULT false NOT NULL,
 "mode" text DEFAULT 'CONFIRM'::text NOT NULL,
 "offset_days" integer DEFAULT 1 NOT NULL,
 "repeat_days" integer DEFAULT 7 NOT NULL,
 "version" integer DEFAULT 1 NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_by" integer
);
CREATE TABLE "public"."sms_settings_history" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "entity" text NOT NULL,
 "entity_id" text NOT NULL,
 "previous" jsonb,
 "current" jsonb NOT NULL,
 "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."sms_templates" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "code" text NOT NULL,
 "name" text NOT NULL,
 "text" text NOT NULL,
 "is_active" boolean DEFAULT true NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "customized_at" timestamp with time zone
);
CREATE TABLE "public"."tasks" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "lead_id" integer,
 "deal_id" integer,
 "assigned_user_id" integer,
 "created_by" integer,
 "type" text DEFAULT 'CALL'::text NOT NULL,
 "title" text NOT NULL,
 "description" text,
 "client_name" text,
 "phone" text,
 "project_name" text,
 "unit_number" text,
 "due_date" text NOT NULL,
 "priority" text DEFAULT 'NORMAL'::text NOT NULL,
 "status" text DEFAULT 'OPEN'::text NOT NULL,
 "completed_at" timestamp with time zone,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "idempotency_key" character varying(255)
);
CREATE TABLE "public"."telegram_finance_deliveries" (
 "telegram_id" text NOT NULL,
 "report_date" date NOT NULL,
 "status" text NOT NULL,
 "started_at" timestamp with time zone DEFAULT now() NOT NULL,
 "finished_at" timestamp with time zone
);
CREATE TABLE "public"."telegram_finance_expense_drafts" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "telegram_id" text NOT NULL,
 "cash_desk_id" uuid NOT NULL,
 "payload" jsonb NOT NULL,
 "status" text DEFAULT 'DRAFT'::text NOT NULL,
 "result" jsonb,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."telegram_finance_sessions" (
 "telegram_id" text NOT NULL,
 "data" jsonb NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."telegram_finance_sheet_outbox" (
 "id" uuid NOT NULL,
 "cash_desk_id" uuid NOT NULL,
 "payload" jsonb NOT NULL,
 "status" text DEFAULT 'PENDING'::text NOT NULL,
 "attempts" integer DEFAULT 0 NOT NULL,
 "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "sent_at" timestamp with time zone
);
CREATE TABLE "public"."telegram_finance_state" (
 "id" integer NOT NULL,
 "update_offset" bigint DEFAULT 0 NOT NULL,
 "worker_id" uuid,
 "lease_until" timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL
);
CREATE TABLE "public"."telegram_finance_subscribers" (
 "telegram_id" text NOT NULL,
 "display_name" text DEFAULT ''::text NOT NULL,
 "username" text DEFAULT ''::text NOT NULL,
 "slot" text,
 "status" text DEFAULT 'PENDING'::text NOT NULL,
 "approved_by" bigint,
 "approved_at" timestamp with time zone,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
 "cash_desk_id" uuid,
 "crm_user_id" integer,
 "can_create_expense" boolean DEFAULT false NOT NULL
);
CREATE TABLE "public"."telegram_finance_updates" (
 "update_id" bigint NOT NULL,
 "payload" jsonb NOT NULL,
 "status" text DEFAULT 'PENDING'::text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "public"."tours_360" (
 "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "project_id" integer NOT NULL,
 "name" text NOT NULL,
 "tour_type" text NOT NULL,
 "entity_type" text,
 "entity_id" integer,
 "is_active" boolean DEFAULT true NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
ALTER TABLE "public"."units" ADD COLUMN "unit_kind" text DEFAULT 'APARTMENT'::text NOT NULL;
CREATE TABLE "public"."user_cash_desk_access" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "user_id" integer NOT NULL,
 "cash_desk_id" uuid NOT NULL,
 "can_view" boolean DEFAULT true NOT NULL,
 "can_create_income" boolean DEFAULT false NOT NULL,
 "can_create_expense" boolean DEFAULT false NOT NULL,
 "can_edit" boolean DEFAULT false NOT NULL,
 "can_void" boolean DEFAULT false NOT NULL,
 "can_delete" boolean DEFAULT false NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "created_by" integer
);
CREATE TABLE "public"."user_notifications" (
 "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
 "user_id" bigint NOT NULL,
 "event_type" character varying(50) NOT NULL,
 "type" character varying(50),
 "title" character varying(255) NOT NULL,
 "message" text NOT NULL,
 "entity_type" character varying(50),
 "entity_id" bigint,
 "action_url" character varying(500),
 "is_read" boolean DEFAULT false NOT NULL,
 "read_at" timestamp with time zone,
 "dedupe_key" character varying(255),
 "metadata" jsonb DEFAULT '{}'::jsonb,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "public"."users" ALTER COLUMN "permissions" DROP NOT NULL;
ALTER TABLE "public"."users" ALTER COLUMN "is_sales_rep" DROP NOT NULL;
CREATE TABLE "tozon_internal"."customer_pko_counter" (
 "id" smallint NOT NULL,
 "last_number" bigint NOT NULL
);
ALTER TABLE public.users DROP CONSTRAINT "users_role_check";
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_check" CHECK (result_cash_desk_id <> source_cash_desk_id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_cost_tjs_minor_check" CHECK (cost_tjs_minor > 0);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_exchange_rate_check" CHECK (exchange_rate > 0::numeric);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_proceeds_tjs_minor_check" CHECK (proceeds_tjs_minor >= 0);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_reclassified_expense_id_key" UNIQUE (reclassified_expense_id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_reclassified_payment_id_key" UNIQUE (reclassified_payment_id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_reclassified_transfer_id_key" UNIQUE (reclassified_transfer_id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_selling_cost_tjs_minor_check" CHECK (selling_cost_tjs_minor >= 0);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_source_currency_check" CHECK (source_currency = ANY (ARRAY['USD'::text, 'TJS'::text]));
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_status_check" CHECK (status = ANY (ARRAY['ACTIVE'::text, 'VOIDED'::text]));
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "cash_transfers_idempotency_key_key" UNIQUE (idempotency_key);
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "cash_transfers_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "chk_transfers_amount_positive" CHECK (amount_minor > 0);
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "chk_transfers_different_desks" CHECK (source_cash_desk_id <> destination_cash_desk_id);
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "chk_transfers_status" CHECK (status::text = ANY (ARRAY['ACTIVE'::character varying, 'VOIDED'::character varying]::text[]));
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_amount_check" CHECK (amount > 0::numeric);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_balance_type_check" CHECK (balance_type = ANY (ARRAY['RECEIVABLE'::text, 'PAYABLE'::text, 'ADVANCE_GIVEN'::text, 'ADVANCE_RECEIVED'::text]));
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_basis_check" CHECK (length(TRIM(BOTH FROM basis)) > 0);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_check" CHECK (NOT (expense_id IS NOT NULL AND payment_id IS NOT NULL));
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_currency_check" CHECK (currency = ANY (ARRAY['TJS'::text, 'USD'::text]));
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_exchange_rate_check" CHECK (exchange_rate > 0::numeric);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_expense_id_key" UNIQUE (expense_id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_kind_check" CHECK (kind = ANY (ARRAY['OPENING_STOCK'::text, 'RECEIPT'::text, 'ISSUE'::text, 'TRANSFER'::text, 'RETURN_STOCK'::text, 'WRITE_OFF'::text, 'OPENING_SETTLEMENT'::text, 'ACCRUAL'::text, 'SETTLEMENT_PAYMENT'::text, 'OPENING_ADVANCE'::text, 'ADVANCE_ISSUE'::text, 'ADVANCE_REPORT'::text, 'ADVANCE_RETURN'::text, 'ADVANCE_REIMBURSE'::text]));
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_lines_check" CHECK (jsonb_typeof(lines) = 'array'::text);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_number_key" UNIQUE (number);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_payment_id_key" UNIQUE (payment_id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_status_check" CHECK (status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'POSTED'::text, 'CANCELLED'::text]));
ALTER TABLE "public"."construction_expense_settlement_audit" ADD CONSTRAINT "construction_expense_settlement_audit_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."construction_materials" ADD CONSTRAINT "construction_materials_name_check" CHECK (length(TRIM(BOTH FROM name)) > 0);
ALTER TABLE "public"."construction_materials" ADD CONSTRAINT "construction_materials_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."construction_materials" ADD CONSTRAINT "construction_materials_unit_check" CHECK (length(TRIM(BOTH FROM unit)) > 0);
ALTER TABLE "public"."construction_parties" ADD CONSTRAINT "construction_parties_kind_check" CHECK (kind = ANY (ARRAY['SUPPLIER'::text, 'CONTRACTOR'::text, 'DEBTOR'::text, 'EMPLOYEE'::text]));
ALTER TABLE "public"."construction_parties" ADD CONSTRAINT "construction_parties_name_check" CHECK (length(TRIM(BOTH FROM name)) > 0);
ALTER TABLE "public"."construction_parties" ADD CONSTRAINT "construction_parties_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."construction_parties" ADD CONSTRAINT "construction_parties_user_id_key" UNIQUE (user_id);
ALTER TABLE "public"."construction_price_corrections" ADD CONSTRAINT "construction_price_corrections_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."construction_price_corrections" ADD CONSTRAINT "construction_price_corrections_reason_check" CHECK (length(TRIM(BOTH FROM reason)) >= 3 AND length(TRIM(BOTH FROM reason)) <= 2000);
ALTER TABLE "public"."construction_price_corrections" ADD CONSTRAINT "construction_price_corrections_receipt_id_version_key" UNIQUE (receipt_id, version);
ALTER TABLE "public"."construction_price_corrections" ADD CONSTRAINT "construction_price_corrections_version_check" CHECK (version > 0);
ALTER TABLE "public"."construction_report_receipts" ADD CONSTRAINT "construction_report_receipts_pkey" PRIMARY KEY (receipt_id);
ALTER TABLE "public"."construction_settings" ADD CONSTRAINT "construction_settings_id_check" CHECK (id = 1);
ALTER TABLE "public"."construction_settings" ADD CONSTRAINT "construction_settings_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."construction_settlement_entries" ADD CONSTRAINT "construction_settlement_entries_account_check" CHECK (account = ANY (ARRAY['RECEIVABLE'::text, 'PAYABLE'::text, 'ADVANCE_GIVEN'::text, 'ADVANCE_RECEIVED'::text, 'EMPLOYEE'::text]));
ALTER TABLE "public"."construction_settlement_entries" ADD CONSTRAINT "construction_settlement_entries_amount_check" CHECK (amount <> 0::numeric);
ALTER TABLE "public"."construction_settlement_entries" ADD CONSTRAINT "construction_settlement_entries_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."construction_stock_entries" ADD CONSTRAINT "construction_stock_entries_check" CHECK ((quantity * value) >= 0::numeric);
ALTER TABLE "public"."construction_stock_entries" ADD CONSTRAINT "construction_stock_entries_currency_check" CHECK (currency = ANY (ARRAY['TJS'::text, 'USD'::text]));
ALTER TABLE "public"."construction_stock_entries" ADD CONSTRAINT "construction_stock_entries_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."construction_stock_entries" ADD CONSTRAINT "construction_stock_entries_quantity_check" CHECK (quantity <> 0::numeric);
ALTER TABLE "public"."construction_warehouses" ADD CONSTRAINT "construction_warehouses_name_check" CHECK (length(TRIM(BOTH FROM name)) > 0);
ALTER TABLE "public"."construction_warehouses" ADD CONSTRAINT "construction_warehouses_name_key" UNIQUE (name);
ALTER TABLE "public"."construction_warehouses" ADD CONSTRAINT "construction_warehouses_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."cost_audit" ADD CONSTRAINT "cost_audit_entity_check" CHECK (entity = ANY (ARRAY['BASIS'::text, 'ALLOCATION'::text]));
ALTER TABLE "public"."cost_audit" ADD CONSTRAINT "cost_audit_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."cost_building_bases" ADD CONSTRAINT "cost_building_bases_pkey" PRIMARY KEY (building_id);
ALTER TABLE "public"."cost_building_bases" ADD CONSTRAINT "cost_building_bases_reason_check" CHECK (length(TRIM(BOTH FROM reason)) >= 3 AND length(TRIM(BOTH FROM reason)) <= 2000);
ALTER TABLE "public"."cost_building_bases" ADD CONSTRAINT "cost_building_bases_sellable_area_m2_check" CHECK (sellable_area_m2 > 0::numeric);
ALTER TABLE "public"."cost_expense_allocations" ADD CONSTRAINT "cost_expense_allocations_mode_check" CHECK (mode = ANY (ARRAY['DIRECT'::text, 'SHARED'::text, 'EXCLUDED'::text, 'UNASSIGNED'::text]));
ALTER TABLE "public"."cost_expense_allocations" ADD CONSTRAINT "cost_expense_allocations_pkey" PRIMARY KEY (expense_id);
ALTER TABLE "public"."cost_expense_allocations" ADD CONSTRAINT "cost_expense_allocations_reason_check" CHECK (length(TRIM(BOTH FROM reason)) >= 3 AND length(TRIM(BOTH FROM reason)) <= 2000);
ALTER TABLE "public"."cost_material_audit" ADD CONSTRAINT "cost_material_audit_entity_check" CHECK (entity = ANY (ARRAY['USAGE'::text, 'PAYMENT'::text]));
ALTER TABLE "public"."cost_material_audit" ADD CONSTRAINT "cost_material_audit_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."cost_material_payment_links" ADD CONSTRAINT "cost_material_payment_links_cash_usd_minor_check" CHECK (cash_usd_minor > 0);
ALTER TABLE "public"."cost_material_payment_links" ADD CONSTRAINT "cost_material_payment_links_paid_amount_check" CHECK (paid_amount > 0::numeric);
ALTER TABLE "public"."cost_material_payment_links" ADD CONSTRAINT "cost_material_payment_links_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."cost_material_payment_links" ADD CONSTRAINT "cost_material_payment_links_reason_check" CHECK (length(TRIM(BOTH FROM reason)) >= 3 AND length(TRIM(BOTH FROM reason)) <= 2000);
ALTER TABLE "public"."cost_material_payment_links" ADD CONSTRAINT "cost_material_payment_links_status_check" CHECK (status = ANY (ARRAY['ACTIVE'::text, 'CANCELLED'::text]));
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_amount_check" CHECK (amount > 0::numeric);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_check" CHECK (currency = 'USD'::text OR exchange_rate IS NOT NULL);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_currency_check" CHECK (currency = ANY (ARRAY['USD'::text, 'TJS'::text]));
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_exchange_rate_check" CHECK (exchange_rate > 0::numeric);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_material_kind_check" CHECK (material_kind = ANY (ARRAY['REBAR'::text, 'CONCRETE'::text]));
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_quantity_check" CHECK (quantity > 0::numeric);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_reason_check" CHECK (length(TRIM(BOTH FROM reason)) >= 3 AND length(TRIM(BOTH FROM reason)) <= 2000);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_status_check" CHECK (status = ANY (ARRAY['ACTIVE'::text, 'CANCELLED'::text]));
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_stock_entry_id_key" UNIQUE (stock_entry_id);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_unit_check" CHECK (length(TRIM(BOTH FROM unit)) >= 1 AND length(TRIM(BOTH FROM unit)) <= 30);
ALTER TABLE "public"."crm_document_settings" ADD CONSTRAINT "crm_document_settings_id_check" CHECK (id = 1);
ALTER TABLE "public"."crm_document_settings" ADD CONSTRAINT "crm_document_settings_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."crm_document_settings_history" ADD CONSTRAINT "crm_document_settings_history_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."crm_document_templates" ADD CONSTRAINT "crm_document_templates_file_base64_check" CHECK (length(file_base64) >= 1 AND length(file_base64) <= 2796204);
ALTER TABLE "public"."crm_document_templates" ADD CONSTRAINT "crm_document_templates_file_size_check" CHECK (file_size >= 1 AND file_size <= 2097152);
ALTER TABLE "public"."crm_document_templates" ADD CONSTRAINT "crm_document_templates_kind_check" CHECK (kind = ANY (ARRAY['CONTRACT'::text, 'ACT'::text, 'PKO'::text, 'RKO'::text, 'SCHEDULE'::text, 'RESERVATION'::text, 'OFFER'::text, 'APARTMENT'::text]));
ALTER TABLE "public"."crm_document_templates" ADD CONSTRAINT "crm_document_templates_language_check" CHECK (language = ANY (ARRAY['TJ'::text, 'RU'::text, 'UZ'::text, 'EN'::text]));
ALTER TABLE "public"."crm_document_templates" ADD CONSTRAINT "crm_document_templates_name_check" CHECK (length(name) >= 1 AND length(name) <= 200);
ALTER TABLE "public"."crm_document_templates" ADD CONSTRAINT "crm_document_templates_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."crm_roles" ADD CONSTRAINT "crm_roles_code_check" CHECK (code ~ '^[A-Z][A-Z0-9_]{1,49}$'::text);
ALTER TABLE "public"."crm_roles" ADD CONSTRAINT "crm_roles_name_check" CHECK (length(TRIM(BOTH FROM name)) >= 2 AND length(TRIM(BOTH FROM name)) <= 100);
ALTER TABLE "public"."crm_roles" ADD CONSTRAINT "crm_roles_permissions_check" CHECK (jsonb_typeof(permissions) = 'array'::text);
ALTER TABLE "public"."crm_roles" ADD CONSTRAINT "crm_roles_pkey" PRIMARY KEY (code);
ALTER TABLE "public"."deal_audit_logs" ADD CONSTRAINT "deal_audit_logs_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."deal_payment_schedules" DROP CONSTRAINT "deal_payment_schedules_status_check";
ALTER TABLE "public"."deal_payment_schedules" ADD CONSTRAINT "deal_payment_schedules_status_check" CHECK (status = ANY (ARRAY['UPCOMING'::text, 'DUE'::text, 'PARTIAL'::text, 'PAID'::text, 'OVERDUE'::text, 'CANCELLED'::text]));
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_discount_snapshot_check" CHECK (discount_snapshot IS NULL OR jsonb_typeof(discount_snapshot) = 'object'::text);
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_installment_interval_months_check" CHECK (installment_interval_months >= 1 AND installment_interval_months <= 12);
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_vehicle_details_valid" CHECK (vehicle_details IS NULL OR jsonb_typeof(vehicle_details) = 'object'::text AND octet_length(vehicle_details::text) <= 16384);
ALTER TABLE "public"."dictionaries" ADD CONSTRAINT "dictionaries_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."discount_schemes" ADD CONSTRAINT "discount_schemes_check" CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on);
ALTER TABLE "public"."discount_schemes" ADD CONSTRAINT "discount_schemes_name_check" CHECK (length(TRIM(BOTH FROM name)) >= 1 AND length(TRIM(BOTH FROM name)) <= 100);
ALTER TABLE "public"."discount_schemes" ADD CONSTRAINT "discount_schemes_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."discount_schemes" ADD CONSTRAINT "discount_schemes_rules_check" CHECK (jsonb_typeof(rules) = 'array'::text AND jsonb_array_length(rules) >= 1 AND jsonb_array_length(rules) <= 30);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expense_settlement_pair" CHECK ((settlement_party_id IS NULL) = (settlement_account IS NULL));
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_amount_minor_check" CHECK (amount_minor > 0);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_amount_usd_check" CHECK (amount_usd IS NULL OR amount_usd >= 0::numeric);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_exchange_rate_check" CHECK (exchange_rate IS NULL OR exchange_rate > 0::numeric);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_idempotency_key_key" UNIQUE (idempotency_key);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_settlement_account_check" CHECK (settlement_account = ANY (ARRAY['PAYABLE'::text, 'ADVANCE_GIVEN'::text, 'RECEIVABLE'::text, 'ADVANCE_RECEIVED'::text]));
ALTER TABLE "public"."finance_audit_backups" ADD CONSTRAINT "finance_audit_backups_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."identity_documents" ADD CONSTRAINT "identity_documents_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."layout_features" ADD CONSTRAINT "layout_features_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."layout_rooms" ADD CONSTRAINT "layout_rooms_area_check" CHECK (area > 0::numeric);
ALTER TABLE "public"."layout_rooms" ADD CONSTRAINT "layout_rooms_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."layout_rooms" ADD CONSTRAINT "layout_rooms_position_x_percent_check" CHECK (position_x_percent >= 0::numeric AND position_x_percent <= 100::numeric);
ALTER TABLE "public"."layout_rooms" ADD CONSTRAINT "layout_rooms_position_y_percent_check" CHECK (position_y_percent >= 0::numeric AND position_y_percent <= 100::numeric);
ALTER TABLE "public"."layout_rooms" ADD CONSTRAINT "layout_rooms_room_number_check" CHECK (room_number > 0);
ALTER TABLE "public"."layout_rooms" ADD CONSTRAINT "uq_layout_room_number" UNIQUE (layout_type_id, room_number);
ALTER TABLE "public"."layout_types" ADD CONSTRAINT "layout_types_balconies_count_check" CHECK (balconies_count IS NULL OR balconies_count >= 0);
ALTER TABLE "public"."layout_types" ADD CONSTRAINT "layout_types_bathrooms_count_check" CHECK (bathrooms_count IS NULL OR bathrooms_count >= 0);
ALTER TABLE "public"."layout_types" ADD CONSTRAINT "layout_types_ceiling_height_check" CHECK (ceiling_height IS NULL OR ceiling_height > 0::numeric);
ALTER TABLE "public"."layout_types" ADD CONSTRAINT "layout_types_doors_count_check" CHECK (doors_count IS NULL OR doors_count >= 0);
ALTER TABLE "public"."layout_types" ADD CONSTRAINT "layout_types_gallery_images_check" CHECK (jsonb_typeof(gallery_images) = 'array'::text);
ALTER TABLE "public"."layout_types" ADD CONSTRAINT "layout_types_kitchen_area_check" CHECK (kitchen_area IS NULL OR kitchen_area > 0::numeric);
ALTER TABLE "public"."layout_types" ADD CONSTRAINT "layout_types_living_area_check" CHECK (living_area IS NULL OR living_area > 0::numeric);
ALTER TABLE "public"."layout_types" ADD CONSTRAINT "layout_types_windows_count_check" CHECK (windows_count IS NULL OR windows_count >= 0);
ALTER TABLE "public"."lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."lead_distribution_settings" ADD CONSTRAINT "lead_distribution_settings_algorithm_check" CHECK (algorithm::text = ANY (ARRAY['LEAST_LOADED'::character varying, 'ROUND_ROBIN'::character varying]::text[]));
ALTER TABLE "public"."lead_distribution_settings" ADD CONSTRAINT "lead_distribution_settings_max_open_leads_per_rep_check" CHECK (max_open_leads_per_rep > 0);
ALTER TABLE "public"."lead_distribution_settings" ADD CONSTRAINT "lead_distribution_settings_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."lead_interested_units" ADD CONSTRAINT "lead_interested_units_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."lead_interested_units" ADD CONSTRAINT "lead_interested_units_priority_check" CHECK (priority::text = ANY (ARRAY['HIGH'::character varying, 'MEDIUM'::character varying, 'LOW'::character varying]::text[]));
ALTER TABLE "public"."lead_interested_units" ADD CONSTRAINT "uq_lead_unit_interest" UNIQUE (lead_id, unit_id);
ALTER TABLE "public"."lead_status_history" ADD CONSTRAINT "lead_status_history_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."panorama_360" ADD CONSTRAINT "panorama_360_entity_type_check" CHECK (entity_type IS NULL OR (entity_type = ANY (ARRAY['BUILDING'::text, 'SECTION'::text, 'FLOOR'::text, 'UNIT'::text, 'POI'::text])));
ALTER TABLE "public"."panorama_360" ADD CONSTRAINT "panorama_360_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."panorama_hotspots" ADD CONSTRAINT "panorama_hotspots_hotspot_type_check" CHECK (hotspot_type = ANY (ARRAY['NAVIGATION'::text, 'UNIT'::text, 'INFO'::text, 'BUILDING'::text, 'FLOOR'::text, 'EXIT'::text]));
ALTER TABLE "public"."panorama_hotspots" ADD CONSTRAINT "panorama_hotspots_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."panorama_hotspots" ADD CONSTRAINT "panorama_hotspots_target_entity_type_check" CHECK (target_entity_type IS NULL OR (target_entity_type = ANY (ARRAY['BUILDING'::text, 'SECTION'::text, 'FLOOR'::text, 'UNIT'::text, 'POI'::text])));
ALTER TABLE "public"."passport_ai_audit_logs" ADD CONSTRAINT "passport_ai_audit_logs_event_type_check" CHECK (event_type::text = ANY (ARRAY['PASSPORT_AI_SCANNED'::character varying, 'PASSPORT_AI_CONFIRMED'::character varying, 'PASSPORT_AI_FAILED'::character varying]::text[]));
ALTER TABLE "public"."passport_ai_audit_logs" ADD CONSTRAINT "passport_ai_audit_logs_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."payments" ADD CONSTRAINT "payments_idempotency_key_key" UNIQUE (idempotency_key);
ALTER TABLE "public"."project_media" ADD CONSTRAINT "project_media_category_check" CHECK (category = ANY (ARRAY['EXTERIOR'::text, 'COURTYARD'::text, 'MASTERPLAN'::text, 'ENTRANCE'::text, 'INTERIOR'::text, 'FLOOR_PLAN'::text, 'COMMERCIAL'::text, 'CONSTRUCTION'::text, 'OTHER'::text]));
ALTER TABLE "public"."project_media" ADD CONSTRAINT "project_media_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."sales_plan_alert_settings" ADD CONSTRAINT "chk_at_risk_threshold" CHECK (at_risk_forecast_threshold_pct >= 10.0 AND at_risk_forecast_threshold_pct <= 99.0);
ALTER TABLE "public"."sales_plan_alert_settings" ADD CONSTRAINT "chk_behind_schedule_threshold" CHECK (behind_schedule_threshold_pp >= 1.0 AND behind_schedule_threshold_pp <= 90.0);
ALTER TABLE "public"."sales_plan_alert_settings" ADD CONSTRAINT "chk_min_working_days" CHECK (min_elapsed_working_days >= 0 AND min_elapsed_working_days <= 15);
ALTER TABLE "public"."sales_plan_alert_settings" ADD CONSTRAINT "chk_single_settings_row" CHECK (id = 1);
ALTER TABLE "public"."sales_plan_alert_settings" ADD CONSTRAINT "chk_weekly_digest_dow" CHECK (weekly_digest_day_of_week >= 1 AND weekly_digest_day_of_week <= 7);
ALTER TABLE "public"."sales_plan_alert_settings" ADD CONSTRAINT "chk_weekly_digest_hour" CHECK (weekly_digest_hour >= 0 AND weekly_digest_hour <= 23);
ALTER TABLE "public"."sales_plan_alert_settings" ADD CONSTRAINT "sales_plan_alert_settings_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."sales_plan_audit_logs" ADD CONSTRAINT "sales_plan_audit_logs_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "chk_sales_plans_currency" CHECK (currency::text = 'USD'::text);
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "chk_sales_plans_deals_count_positive" CHECK (target_deals_count >= 0);
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "chk_sales_plans_period_format" CHECK (period::text ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text);
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "chk_sales_plans_scope_refs" CHECK (scope_type::text = 'DEPARTMENT'::text AND manager_id IS NULL AND project_id IS NULL AND building_id IS NULL OR scope_type::text = 'MANAGER'::text AND manager_id IS NOT NULL AND project_id IS NULL AND building_id IS NULL OR scope_type::text = 'PROJECT'::text AND project_id IS NOT NULL AND manager_id IS NULL AND building_id IS NULL OR scope_type::text = 'BUILDING'::text AND building_id IS NOT NULL AND manager_id IS NULL);
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "chk_sales_plans_scope_type" CHECK (scope_type::text = ANY (ARRAY['DEPARTMENT'::character varying, 'MANAGER'::character varying, 'PROJECT'::character varying, 'BUILDING'::character varying]::text[]));
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "chk_sales_plans_status" CHECK (status::text = ANY (ARRAY['DRAFT'::character varying, 'APPROVED'::character varying, 'ACTIVE_LOCKED'::character varying]::text[]));
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "chk_sales_plans_volume_positive" CHECK (target_volume_minor >= 0);
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "sales_plans_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."scene_3d" ADD CONSTRAINT "scene_3d_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."scene_3d" ADD CONSTRAINT "scene_3d_scene_type_check" CHECK (scene_type = ANY (ARRAY['MASTERPLAN'::text, 'BUILDING'::text, 'FLOOR'::text, 'APARTMENT'::text]));
ALTER TABLE "public"."scene_3d_entities" ADD CONSTRAINT "scene_3d_entities_entity_type_check" CHECK (entity_type = ANY (ARRAY['BUILDING'::text, 'SECTION'::text, 'FLOOR'::text, 'UNIT'::text, 'POI'::text]));
ALTER TABLE "public"."scene_3d_entities" ADD CONSTRAINT "scene_3d_entities_interaction_type_check" CHECK (interaction_type = ANY (ARRAY['SELECT'::text, 'HOVER_INFO'::text, 'FOCUS'::text, 'NONE'::text]));
ALTER TABLE "public"."scene_3d_entities" ADD CONSTRAINT "scene_3d_entities_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."scene_3d_entities" ADD CONSTRAINT "uq_scene_mesh" UNIQUE (scene_id, mesh_key);
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "chk_sms_events_mode" CHECK (mode::text = ANY (ARRAY['CONFIRM'::character varying, 'AUTO'::character varying, 'OFF'::character varying]::text[]));
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "chk_sms_events_status" CHECK (status::text = ANY (ARRAY['AWAITING_CONFIRMATION'::character varying, 'PROCESSING'::character varying, 'SENT'::character varying, 'CANCELLED'::character varying, 'FAILED'::character varying, 'DELIVERY_UNKNOWN'::character varying]::text[]));
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "sms_events_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "uq_sms_events_idempotency_key" UNIQUE (idempotency_key);
ALTER TABLE "public"."sms_messages" ADD CONSTRAINT "sms_messages_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."sms_messages" ADD CONSTRAINT "sms_messages_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'delivered'::text, 'failed'::text]));
ALTER TABLE "public"."sms_notification_rules" ADD CONSTRAINT "sms_notification_rules_check" CHECK (mode = 'CONFIRM'::text OR event_type = 'PAYMENT_REMINDER'::text);
ALTER TABLE "public"."sms_notification_rules" ADD CONSTRAINT "sms_notification_rules_mode_check" CHECK (mode = ANY (ARRAY['CONFIRM'::text, 'INHERIT'::text]));
ALTER TABLE "public"."sms_notification_rules" ADD CONSTRAINT "sms_notification_rules_offset_days_check" CHECK (offset_days >= 0 AND offset_days <= 30);
ALTER TABLE "public"."sms_notification_rules" ADD CONSTRAINT "sms_notification_rules_pkey" PRIMARY KEY (event_type);
ALTER TABLE "public"."sms_notification_rules" ADD CONSTRAINT "sms_notification_rules_repeat_days_check" CHECK (repeat_days >= 1 AND repeat_days <= 90);
ALTER TABLE "public"."sms_settings_history" ADD CONSTRAINT "sms_settings_history_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."sms_templates" ADD CONSTRAINT "sms_templates_code_key" UNIQUE (code);
ALTER TABLE "public"."sms_templates" ADD CONSTRAINT "sms_templates_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."telegram_finance_deliveries" ADD CONSTRAINT "telegram_finance_deliveries_pkey" PRIMARY KEY (telegram_id, report_date);
ALTER TABLE "public"."telegram_finance_deliveries" ADD CONSTRAINT "telegram_finance_deliveries_status_check" CHECK (status = ANY (ARRAY['PROCESSING'::text, 'SENT'::text, 'UNKNOWN'::text]));
ALTER TABLE "public"."telegram_finance_expense_drafts" ADD CONSTRAINT "telegram_finance_expense_drafts_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."telegram_finance_expense_drafts" ADD CONSTRAINT "telegram_finance_expense_drafts_status_check" CHECK (status = ANY (ARRAY['DRAFT'::text, 'POSTED'::text, 'CANCELLED'::text]));
ALTER TABLE "public"."telegram_finance_sessions" ADD CONSTRAINT "telegram_finance_sessions_pkey" PRIMARY KEY (telegram_id);
ALTER TABLE "public"."telegram_finance_sheet_outbox" ADD CONSTRAINT "telegram_finance_sheet_outbox_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."telegram_finance_sheet_outbox" ADD CONSTRAINT "telegram_finance_sheet_outbox_status_check" CHECK (status = ANY (ARRAY['PENDING'::text, 'SENT'::text, 'UNMAPPED'::text]));
ALTER TABLE "public"."telegram_finance_state" ADD CONSTRAINT "telegram_finance_state_id_check" CHECK (id = 1);
ALTER TABLE "public"."telegram_finance_state" ADD CONSTRAINT "telegram_finance_state_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."telegram_finance_subscribers" ADD CONSTRAINT "telegram_finance_subscribers_check" CHECK (status = 'APPROVED'::text AND slot IS NOT NULL OR status <> 'APPROVED'::text AND slot IS NULL);
ALTER TABLE "public"."telegram_finance_subscribers" ADD CONSTRAINT "telegram_finance_subscribers_pkey" PRIMARY KEY (telegram_id);
ALTER TABLE "public"."telegram_finance_subscribers" ADD CONSTRAINT "telegram_finance_subscribers_slot_check" CHECK (slot = ANY (ARRAY['AKMALKHON'::text, 'ILHOM'::text, 'ASRORKHON'::text, 'MUBINCHON'::text]));
ALTER TABLE "public"."telegram_finance_subscribers" ADD CONSTRAINT "telegram_finance_subscribers_slot_key" UNIQUE (slot);
ALTER TABLE "public"."telegram_finance_subscribers" ADD CONSTRAINT "telegram_finance_subscribers_status_check" CHECK (status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REVOKED'::text]));
ALTER TABLE "public"."telegram_finance_subscribers" ADD CONSTRAINT "telegram_finance_subscribers_telegram_id_check" CHECK (telegram_id ~ '^[1-9][0-9]{0,15}$'::text);
ALTER TABLE "public"."telegram_finance_updates" ADD CONSTRAINT "telegram_finance_updates_pkey" PRIMARY KEY (update_id);
ALTER TABLE "public"."telegram_finance_updates" ADD CONSTRAINT "telegram_finance_updates_status_check" CHECK (status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'DONE'::text]));
ALTER TABLE "public"."tours_360" ADD CONSTRAINT "tours_360_entity_type_check" CHECK (entity_type IS NULL OR (entity_type = ANY (ARRAY['BUILDING'::text, 'SECTION'::text, 'FLOOR'::text, 'UNIT'::text, 'POI'::text])));
ALTER TABLE "public"."tours_360" ADD CONSTRAINT "tours_360_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."tours_360" ADD CONSTRAINT "tours_360_tour_type_check" CHECK (tour_type = ANY (ARRAY['PROJECT'::text, 'BUILDING'::text, 'FLOOR'::text, 'UNIT'::text, 'SHOWROOM'::text, 'COURTYARD'::text]));
ALTER TABLE "public"."units" ADD CONSTRAINT "units_unit_kind_check" CHECK (unit_kind = ANY (ARRAY['APARTMENT'::text, 'COMMERCIAL'::text, 'PARKING'::text]));
ALTER TABLE "public"."user_cash_desk_access" ADD CONSTRAINT "uq_user_cash_desk" UNIQUE (user_id, cash_desk_id);
ALTER TABLE "public"."user_cash_desk_access" ADD CONSTRAINT "user_cash_desk_access_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."user_notifications" ADD CONSTRAINT "user_notifications_dedupe_key_key" UNIQUE (dedupe_key);
ALTER TABLE "public"."user_notifications" ADD CONSTRAINT "user_notifications_pkey" PRIMARY KEY (id);
ALTER TABLE "tozon_internal"."customer_pko_counter" ADD CONSTRAINT "customer_pko_counter_id_check" CHECK (id = 1);
ALTER TABLE "tozon_internal"."customer_pko_counter" ADD CONSTRAINT "customer_pko_counter_last_number_check" CHECK (last_number >= 0);
ALTER TABLE "tozon_internal"."customer_pko_counter" ADD CONSTRAINT "customer_pko_counter_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_purchase_payment_id_fkey" FOREIGN KEY (purchase_payment_id) REFERENCES payments(id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_reclassified_expense_id_fkey" FOREIGN KEY (reclassified_expense_id) REFERENCES expenses(id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_reclassified_payment_id_fkey" FOREIGN KEY (reclassified_payment_id) REFERENCES payments(id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_reclassified_transfer_id_fkey" FOREIGN KEY (reclassified_transfer_id) REFERENCES cash_transfers(id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_result_cash_desk_id_fkey" FOREIGN KEY (result_cash_desk_id) REFERENCES dictionaries(id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_sale_transfer_id_fkey" FOREIGN KEY (sale_transfer_id) REFERENCES cash_transfers(id);
ALTER TABLE "public"."barter_realization_results" ADD CONSTRAINT "barter_realization_results_source_cash_desk_id_fkey" FOREIGN KEY (source_cash_desk_id) REFERENCES dictionaries(id);
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "cash_transfers_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "cash_transfers_destination_cash_desk_id_fkey" FOREIGN KEY (destination_cash_desk_id) REFERENCES dictionaries(id);
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "cash_transfers_destination_payment_id_fkey" FOREIGN KEY (destination_payment_id) REFERENCES payments(id) ON DELETE SET NULL;
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "cash_transfers_source_cash_desk_id_fkey" FOREIGN KEY (source_cash_desk_id) REFERENCES dictionaries(id);
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "cash_transfers_source_expense_id_fkey" FOREIGN KEY (source_expense_id) REFERENCES expenses(id) ON DELETE SET NULL;
ALTER TABLE "public"."cash_transfers" ADD CONSTRAINT "cash_transfers_voided_by_fkey" FOREIGN KEY (voided_by) REFERENCES users(id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_destination_id_fkey" FOREIGN KEY (destination_id) REFERENCES construction_warehouses(id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_expense_id_fkey" FOREIGN KEY (expense_id) REFERENCES expenses(id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_party_id_fkey" FOREIGN KEY (party_id) REFERENCES construction_parties(id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_payment_id_fkey" FOREIGN KEY (payment_id) REFERENCES payments(id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_posted_by_fkey" FOREIGN KEY (posted_by) REFERENCES users(id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE "public"."construction_documents" ADD CONSTRAINT "construction_documents_warehouse_id_fkey" FOREIGN KEY (warehouse_id) REFERENCES construction_warehouses(id);
ALTER TABLE "public"."construction_expense_settlement_audit" ADD CONSTRAINT "construction_expense_settlement_audit_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES users(id);
ALTER TABLE "public"."construction_parties" ADD CONSTRAINT "construction_parties_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE "public"."construction_price_corrections" ADD CONSTRAINT "construction_price_corrections_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES users(id);
ALTER TABLE "public"."construction_price_corrections" ADD CONSTRAINT "construction_price_corrections_receipt_id_fkey" FOREIGN KEY (receipt_id) REFERENCES construction_documents(id);
ALTER TABLE "public"."construction_report_receipts" ADD CONSTRAINT "construction_report_receipts_receipt_id_fkey" FOREIGN KEY (receipt_id) REFERENCES construction_documents(id);
ALTER TABLE "public"."construction_report_receipts" ADD CONSTRAINT "construction_report_receipts_report_id_fkey" FOREIGN KEY (report_id) REFERENCES construction_documents(id);
ALTER TABLE "public"."construction_settings" ADD CONSTRAINT "construction_settings_approver_user_id_fkey" FOREIGN KEY (approver_user_id) REFERENCES users(id);
ALTER TABLE "public"."construction_settlement_entries" ADD CONSTRAINT "construction_settlement_entries_document_id_fkey" FOREIGN KEY (document_id) REFERENCES construction_documents(id);
ALTER TABLE "public"."construction_settlement_entries" ADD CONSTRAINT "construction_settlement_entries_party_id_fkey" FOREIGN KEY (party_id) REFERENCES construction_parties(id);
ALTER TABLE "public"."construction_stock_entries" ADD CONSTRAINT "construction_stock_entries_document_id_fkey" FOREIGN KEY (document_id) REFERENCES construction_documents(id);
ALTER TABLE "public"."construction_stock_entries" ADD CONSTRAINT "construction_stock_entries_material_id_fkey" FOREIGN KEY (material_id) REFERENCES construction_materials(id);
ALTER TABLE "public"."construction_stock_entries" ADD CONSTRAINT "construction_stock_entries_warehouse_id_fkey" FOREIGN KEY (warehouse_id) REFERENCES construction_warehouses(id);
ALTER TABLE "public"."construction_warehouses" ADD CONSTRAINT "construction_warehouses_responsible_id_fkey" FOREIGN KEY (responsible_id) REFERENCES construction_parties(id);
ALTER TABLE "public"."cost_audit" ADD CONSTRAINT "cost_audit_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES users(id);
ALTER TABLE "public"."cost_building_bases" ADD CONSTRAINT "cost_building_bases_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(id);
ALTER TABLE "public"."cost_building_bases" ADD CONSTRAINT "cost_building_bases_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES users(id);
ALTER TABLE "public"."cost_expense_allocations" ADD CONSTRAINT "cost_expense_allocations_expense_id_fkey" FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE;
ALTER TABLE "public"."cost_expense_allocations" ADD CONSTRAINT "cost_expense_allocations_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES users(id);
ALTER TABLE "public"."cost_material_audit" ADD CONSTRAINT "cost_material_audit_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES users(id);
ALTER TABLE "public"."cost_material_payment_links" ADD CONSTRAINT "cost_material_payment_links_expense_id_fkey" FOREIGN KEY (expense_id) REFERENCES expenses(id);
ALTER TABLE "public"."cost_material_payment_links" ADD CONSTRAINT "cost_material_payment_links_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES users(id);
ALTER TABLE "public"."cost_material_payment_links" ADD CONSTRAINT "cost_material_payment_links_usage_id_fkey" FOREIGN KEY (usage_id) REFERENCES cost_material_usages(id);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(id);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_stock_entry_id_fkey" FOREIGN KEY (stock_entry_id) REFERENCES construction_stock_entries(id);
ALTER TABLE "public"."cost_material_usages" ADD CONSTRAINT "cost_material_usages_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES users(id);
ALTER TABLE "public"."deal_audit_logs" ADD CONSTRAINT "deal_audit_logs_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE "public"."deal_audit_logs" ADD CONSTRAINT "deal_audit_logs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_refund_expense_id_fkey" FOREIGN KEY (refund_expense_id) REFERENCES expenses(id) ON DELETE SET NULL;
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_terminated_by_user_id_fkey" FOREIGN KEY (terminated_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."discount_schemes" ADD CONSTRAINT "discount_schemes_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_cash_desk_id_fkey" FOREIGN KEY (cash_desk_id) REFERENCES dictionaries(id);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_conversion_expense_id_fkey" FOREIGN KEY (conversion_expense_id) REFERENCES expenses(id);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_created_by_user_id_fkey" FOREIGN KEY (created_by_user_id) REFERENCES users(id);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_settlement_party_id_fkey" FOREIGN KEY (settlement_party_id) REFERENCES construction_parties(id);
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_settlement_updated_by_fkey" FOREIGN KEY (settlement_updated_by) REFERENCES users(id);
ALTER TABLE "public"."identity_documents" ADD CONSTRAINT "identity_documents_created_by_user_id_fkey" FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."identity_documents" ADD CONSTRAINT "identity_documents_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE "public"."identity_documents" ADD CONSTRAINT "identity_documents_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE "public"."identity_documents" ADD CONSTRAINT "identity_documents_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE "public"."identity_documents" ADD CONSTRAINT "identity_documents_verified_by_user_id_fkey" FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."layout_features" ADD CONSTRAINT "layout_features_layout_type_id_fkey" FOREIGN KEY (layout_type_id) REFERENCES layout_types(id) ON DELETE CASCADE;
ALTER TABLE "public"."layout_rooms" ADD CONSTRAINT "layout_rooms_layout_type_id_fkey" FOREIGN KEY (layout_type_id) REFERENCES layout_types(id) ON DELETE CASCADE;
ALTER TABLE "public"."lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_assigned_by_user_id_fkey" FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_from_user_id_fkey" FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE "public"."lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_to_user_id_fkey" FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."lead_distribution_settings" ADD CONSTRAINT "lead_distribution_settings_updated_by_user_id_fkey" FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."lead_interested_units" ADD CONSTRAINT "lead_interested_units_created_by_user_id_fkey" FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."lead_interested_units" ADD CONSTRAINT "lead_interested_units_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE "public"."lead_interested_units" ADD CONSTRAINT "lead_interested_units_unit_id_fkey" FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE;
ALTER TABLE "public"."lead_status_history" ADD CONSTRAINT "lead_status_history_changed_by_user_id_fkey" FOREIGN KEY (changed_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."lead_status_history" ADD CONSTRAINT "lead_status_history_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE "public"."leads" ADD CONSTRAINT "leads_first_contact_by_user_id_fkey" FOREIGN KEY (first_contact_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."panorama_360" ADD CONSTRAINT "panorama_360_tour_id_fkey" FOREIGN KEY (tour_id) REFERENCES tours_360(id) ON DELETE CASCADE;
ALTER TABLE "public"."panorama_hotspots" ADD CONSTRAINT "panorama_hotspots_panorama_id_fkey" FOREIGN KEY (panorama_id) REFERENCES panorama_360(id) ON DELETE CASCADE;
ALTER TABLE "public"."panorama_hotspots" ADD CONSTRAINT "panorama_hotspots_target_panorama_id_fkey" FOREIGN KEY (target_panorama_id) REFERENCES panorama_360(id) ON DELETE SET NULL;
ALTER TABLE "public"."passport_ai_audit_logs" ADD CONSTRAINT "passport_ai_audit_logs_client_id_fkey" FOREIGN KEY (client_id) REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE "public"."passport_ai_audit_logs" ADD CONSTRAINT "passport_ai_audit_logs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."payments" ADD CONSTRAINT "payments_cash_desk_id_fkey" FOREIGN KEY (cash_desk_id) REFERENCES dictionaries(id);
ALTER TABLE "public"."project_media" ADD CONSTRAINT "project_media_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE "public"."sales_plan_alert_settings" ADD CONSTRAINT "sales_plan_alert_settings_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."sales_plan_audit_logs" ADD CONSTRAINT "sales_plan_audit_logs_changed_by_user_id_fkey" FOREIGN KEY (changed_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."sales_plan_audit_logs" ADD CONSTRAINT "sales_plan_audit_logs_sales_plan_id_fkey" FOREIGN KEY (sales_plan_id) REFERENCES sales_plans(id) ON DELETE CASCADE;
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "sales_plans_approved_by_fkey" FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "sales_plans_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE;
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "sales_plans_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "sales_plans_manager_id_fkey" FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE "public"."sales_plans" ADD CONSTRAINT "sales_plans_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE "public"."scene_3d" ADD CONSTRAINT "scene_3d_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE SET NULL;
ALTER TABLE "public"."scene_3d" ADD CONSTRAINT "scene_3d_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE "public"."scene_3d_entities" ADD CONSTRAINT "scene_3d_entities_scene_id_fkey" FOREIGN KEY (scene_id) REFERENCES scene_3d(id) ON DELETE CASCADE;
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "sms_events_cancelled_by_fkey" FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "sms_events_client_id_fkey" FOREIGN KEY (client_id) REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "sms_events_confirmed_by_fkey" FOREIGN KEY (confirmed_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "sms_events_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "sms_events_payment_id_fkey" FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "sms_events_schedule_id_fkey" FOREIGN KEY (schedule_id) REFERENCES deal_payment_schedules(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_events" ADD CONSTRAINT "sms_events_task_id_fkey" FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_messages" ADD CONSTRAINT "sms_messages_client_id_fkey" FOREIGN KEY (client_id) REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_messages" ADD CONSTRAINT "sms_messages_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_messages" ADD CONSTRAINT "sms_messages_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_messages" ADD CONSTRAINT "sms_messages_event_id_fkey" FOREIGN KEY (event_id) REFERENCES sms_events(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_messages" ADD CONSTRAINT "sms_messages_payment_id_fkey" FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
ALTER TABLE "public"."sms_notification_rules" ADD CONSTRAINT "sms_notification_rules_template_code_fkey" FOREIGN KEY (template_code) REFERENCES sms_templates(code);
ALTER TABLE "public"."sms_notification_rules" ADD CONSTRAINT "sms_notification_rules_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES users(id);
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_assigned_user_id_fkey" FOREIGN KEY (assigned_user_id) REFERENCES users(id);
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE "public"."telegram_finance_deliveries" ADD CONSTRAINT "telegram_finance_deliveries_telegram_id_fkey" FOREIGN KEY (telegram_id) REFERENCES telegram_finance_subscribers(telegram_id);
ALTER TABLE "public"."telegram_finance_expense_drafts" ADD CONSTRAINT "telegram_finance_expense_drafts_cash_desk_id_fkey" FOREIGN KEY (cash_desk_id) REFERENCES dictionaries(id);
ALTER TABLE "public"."telegram_finance_expense_drafts" ADD CONSTRAINT "telegram_finance_expense_drafts_telegram_id_fkey" FOREIGN KEY (telegram_id) REFERENCES telegram_finance_subscribers(telegram_id);
ALTER TABLE "public"."telegram_finance_sessions" ADD CONSTRAINT "telegram_finance_sessions_telegram_id_fkey" FOREIGN KEY (telegram_id) REFERENCES telegram_finance_subscribers(telegram_id);
ALTER TABLE "public"."telegram_finance_sheet_outbox" ADD CONSTRAINT "telegram_finance_sheet_outbox_id_fkey" FOREIGN KEY (id) REFERENCES telegram_finance_expense_drafts(id);
ALTER TABLE "public"."telegram_finance_subscribers" ADD CONSTRAINT "telegram_finance_subscribers_cash_desk_id_fkey" FOREIGN KEY (cash_desk_id) REFERENCES dictionaries(id);
ALTER TABLE "public"."telegram_finance_subscribers" ADD CONSTRAINT "telegram_finance_subscribers_crm_user_id_fkey" FOREIGN KEY (crm_user_id) REFERENCES users(id);
ALTER TABLE "public"."tours_360" ADD CONSTRAINT "tours_360_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE "public"."user_cash_desk_access" ADD CONSTRAINT "fk_user_cash_desk_dict" FOREIGN KEY (cash_desk_id) REFERENCES dictionaries(id) ON DELETE CASCADE;
ALTER TABLE "public"."user_cash_desk_access" ADD CONSTRAINT "fk_user_cash_desk_user" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE "public"."user_notifications" ADD CONSTRAINT "user_notifications_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE "public"."users" ADD CONSTRAINT "users_role_fkey" FOREIGN KEY (role) REFERENCES crm_roles(code) ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE INDEX barter_realization_results_result_desk_idx ON public.barter_realization_results USING btree (result_cash_desk_id);
CREATE INDEX barter_realization_results_source_desk_idx ON public.barter_realization_results USING btree (source_cash_desk_id);
CREATE INDEX idx_cash_transfers_idempotency ON public.cash_transfers USING btree (idempotency_key);
CREATE INDEX construction_party_balance ON public.construction_settlement_entries USING btree (party_id, currency, account);
CREATE INDEX construction_stock_balance ON public.construction_stock_entries USING btree (warehouse_id, material_id, currency);
CREATE INDEX cost_audit_entity_idx ON public.cost_audit USING btree (entity, entity_id, id DESC);
CREATE INDEX cost_material_audit_entity ON public.cost_material_audit USING btree (entity, entity_id, id DESC);
CREATE UNIQUE INDEX cost_material_payment_active_pair ON public.cost_material_payment_links USING btree (usage_id, expense_id) WHERE (status = 'ACTIVE'::text);
CREATE INDEX cost_material_payment_expense ON public.cost_material_payment_links USING btree (expense_id);
CREATE INDEX cost_material_usages_block_date ON public.cost_material_usages USING btree (building_id, usage_date);
CREATE UNIQUE INDEX crm_document_template_active_slot ON public.crm_document_templates USING btree (kind, language, scope) WHERE active;
CREATE INDEX crm_document_template_history ON public.crm_document_templates USING btree (kind, language, scope, created_at DESC);
CREATE INDEX idx_dictionaries_type ON public.dictionaries USING btree (type, is_active, sort_order);
CREATE INDEX discount_schemes_project_id_idx ON public.discount_schemes USING btree (project_id);
CREATE UNIQUE INDEX crm_expense_document_number ON public.expenses USING btree (document_number) WHERE (document_number IS NOT NULL);
CREATE INDEX expense_settlement_party ON public.expenses USING btree (settlement_party_id) WHERE (settlement_party_id IS NOT NULL);
CREATE INDEX idx_expenses_cash_desk_id ON public.expenses USING btree (cash_desk_id);
CREATE INDEX idx_expenses_conversion_expense_id ON public.expenses USING btree (conversion_expense_id);
CREATE INDEX idx_expenses_conversion_id ON public.expenses USING btree (conversion_id);
CREATE INDEX idx_expenses_deal_id ON public.expenses USING btree (deal_id);
CREATE INDEX idx_expenses_idempotency_key ON public.expenses USING btree (idempotency_key);
CREATE INDEX idx_expenses_status ON public.expenses USING btree (status);
CREATE INDEX idx_expenses_transfer_id ON public.expenses USING btree (transfer_id);
CREATE INDEX idx_identity_docs_deal ON public.identity_documents USING btree (deal_id);
CREATE INDEX idx_identity_docs_lead ON public.identity_documents USING btree (lead_id);
CREATE INDEX idx_identity_docs_status ON public.identity_documents USING btree (status);
CREATE INDEX idx_layout_features_layout ON public.layout_features USING btree (layout_type_id);
CREATE INDEX idx_layout_features_sort ON public.layout_features USING btree (layout_type_id, sort_order);
CREATE INDEX idx_layout_rooms_layout ON public.layout_rooms USING btree (layout_type_id);
CREATE INDEX idx_layout_rooms_sort ON public.layout_rooms USING btree (layout_type_id, sort_order, room_number);
CREATE INDEX idx_lead_assignment_created_at ON public.lead_assignment_history USING btree (created_at);
CREATE INDEX idx_lead_assignment_lead_id ON public.lead_assignment_history USING btree (lead_id);
CREATE INDEX idx_lead_assignment_to_user ON public.lead_assignment_history USING btree (to_user_id);
CREATE INDEX idx_lead_interested_units_lead_id ON public.lead_interested_units USING btree (lead_id);
CREATE INDEX idx_lead_interested_units_priority ON public.lead_interested_units USING btree (priority);
CREATE INDEX idx_lead_interested_units_unit_id ON public.lead_interested_units USING btree (unit_id);
CREATE INDEX idx_lead_status_history_created_at ON public.lead_status_history USING btree (created_at);
CREATE INDEX idx_lead_status_history_lead_id ON public.lead_status_history USING btree (lead_id);
CREATE INDEX idx_lead_status_history_to_status ON public.lead_status_history USING btree (to_status);
CREATE INDEX idx_lead_status_history_user ON public.lead_status_history USING btree (changed_by_user_id);
CREATE INDEX idx_leads_assigned_at ON public.leads USING btree (assigned_at);
CREATE INDEX idx_leads_first_contact_at ON public.leads USING btree (first_contact_at);
CREATE INDEX idx_leads_idempotency_key ON public.leads USING btree (idempotency_key);
CREATE INDEX idx_leads_inn ON public.leads USING btree (inn);
CREATE INDEX idx_leads_responsible_status ON public.leads USING btree (responsible_user_id, status);
CREATE INDEX idx_panorama_360_sort ON public.panorama_360 USING btree (tour_id, sort_order);
CREATE INDEX idx_panorama_360_tour ON public.panorama_360 USING btree (tour_id);
CREATE INDEX idx_hotspots_panorama ON public.panorama_hotspots USING btree (panorama_id);
CREATE INDEX idx_hotspots_target_pano ON public.panorama_hotspots USING btree (target_panorama_id);
CREATE INDEX idx_passport_ai_logs_client ON public.passport_ai_audit_logs USING btree (client_id);
CREATE INDEX idx_passport_ai_logs_event ON public.passport_ai_audit_logs USING btree (event_type);
CREATE INDEX idx_passport_ai_logs_user ON public.passport_ai_audit_logs USING btree (user_id);
CREATE UNIQUE INDEX crm_payment_document_number ON public.payments USING btree (document_number) WHERE (document_number IS NOT NULL);
CREATE INDEX idx_payments_cash_desk_id ON public.payments USING btree (cash_desk_id);
CREATE INDEX idx_payments_conversion_id ON public.payments USING btree (conversion_id);
CREATE INDEX idx_payments_status ON public.payments USING btree (status);
CREATE INDEX idx_payments_transfer_id ON public.payments USING btree (transfer_id);
CREATE UNIQUE INDEX payments_customer_pko_number_key ON public.payments USING btree (customer_pko_number) WHERE (customer_pko_number IS NOT NULL);
CREATE INDEX idx_project_media_category ON public.project_media USING btree (project_id, category);
CREATE INDEX idx_project_media_project ON public.project_media USING btree (project_id);
CREATE INDEX idx_project_media_sort ON public.project_media USING btree (project_id, sort_order);
CREATE UNIQUE INDEX uq_project_cover ON public.project_media USING btree (project_id) WHERE (is_cover = true);
CREATE INDEX idx_sales_plan_audit_created ON public.sales_plan_audit_logs USING btree (created_at);
CREATE INDEX idx_sales_plan_audit_plan ON public.sales_plan_audit_logs USING btree (sales_plan_id);
CREATE INDEX idx_sales_plan_audit_user ON public.sales_plan_audit_logs USING btree (changed_by_user_id);
CREATE INDEX idx_sales_plans_building ON public.sales_plans USING btree (building_id);
CREATE INDEX idx_sales_plans_manager ON public.sales_plans USING btree (manager_id);
CREATE INDEX idx_sales_plans_period ON public.sales_plans USING btree (period);
CREATE INDEX idx_sales_plans_project ON public.sales_plans USING btree (project_id);
CREATE INDEX idx_sales_plans_scope ON public.sales_plans USING btree (scope_type);
CREATE UNIQUE INDEX uq_sales_plans_building ON public.sales_plans USING btree (period, building_id) WHERE ((scope_type)::text = 'BUILDING'::text);
CREATE UNIQUE INDEX uq_sales_plans_department ON public.sales_plans USING btree (period) WHERE ((scope_type)::text = 'DEPARTMENT'::text);
CREATE UNIQUE INDEX uq_sales_plans_manager ON public.sales_plans USING btree (period, manager_id) WHERE ((scope_type)::text = 'MANAGER'::text);
CREATE UNIQUE INDEX uq_sales_plans_project ON public.sales_plans USING btree (period, project_id) WHERE ((scope_type)::text = 'PROJECT'::text);
CREATE INDEX idx_scene_3d_active ON public.scene_3d USING btree (is_active);
CREATE INDEX idx_scene_3d_building ON public.scene_3d USING btree (building_id);
CREATE INDEX idx_scene_3d_project ON public.scene_3d USING btree (project_id);
CREATE UNIQUE INDEX uq_active_scene ON public.scene_3d USING btree (project_id, COALESCE(building_id, '-1'::integer), scene_type) WHERE (is_active = true);
CREATE INDEX idx_scene_entities_lookup ON public.scene_3d_entities USING btree (entity_type, entity_id);
CREATE INDEX idx_scene_entities_mesh ON public.scene_3d_entities USING btree (mesh_key);
CREATE INDEX idx_scene_entities_scene ON public.scene_3d_entities USING btree (scene_id);
CREATE INDEX idx_sms_events_client_id ON public.sms_events USING btree (client_id);
CREATE INDEX idx_sms_events_created_at ON public.sms_events USING btree (created_at DESC);
CREATE INDEX idx_sms_events_deal_id ON public.sms_events USING btree (deal_id);
CREATE INDEX idx_sms_events_payment_id ON public.sms_events USING btree (payment_id);
CREATE INDEX idx_sms_events_schedule_id ON public.sms_events USING btree (schedule_id);
CREATE INDEX idx_sms_events_status_available ON public.sms_events USING btree (status, available_at);
CREATE INDEX idx_sms_events_task_id ON public.sms_events USING btree (task_id);
CREATE INDEX idx_sms_messages_client_id ON public.sms_messages USING btree (client_id);
CREATE INDEX idx_sms_messages_created_at ON public.sms_messages USING btree (created_at DESC);
CREATE INDEX idx_sms_messages_event_id ON public.sms_messages USING btree (event_id);
CREATE INDEX idx_sms_messages_payment_id ON public.sms_messages USING btree (payment_id);
CREATE INDEX idx_sms_messages_phone ON public.sms_messages USING btree (phone);
CREATE INDEX idx_sms_messages_status ON public.sms_messages USING btree (status);
CREATE UNIQUE INDEX idx_sms_messages_unique_payment_sent ON public.sms_messages USING btree (payment_id) WHERE ((payment_id IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'delivered'::text])));
CREATE INDEX idx_tasks_assigned_user ON public.tasks USING btree (assigned_user_id);
CREATE INDEX idx_tasks_deal_id ON public.tasks USING btree (deal_id);
CREATE INDEX idx_tasks_lead_id ON public.tasks USING btree (lead_id);
CREATE INDEX idx_tasks_status ON public.tasks USING btree (status);
CREATE UNIQUE INDEX uq_tasks_idempotency_key ON public.tasks USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE UNIQUE INDEX uq_tasks_open_deal_type ON public.tasks USING btree (deal_id, type) WHERE ((status = 'OPEN'::text) AND (deal_id IS NOT NULL));
CREATE UNIQUE INDEX uq_tasks_open_lead_call ON public.tasks USING btree (lead_id, type) WHERE ((status = 'OPEN'::text) AND (lead_id IS NOT NULL) AND (type = 'CALL'::text));
CREATE INDEX telegram_finance_updates_pending ON public.telegram_finance_updates USING btree (update_id) WHERE (status = 'PENDING'::text);
CREATE INDEX idx_tours_360_entity ON public.tours_360 USING btree (entity_type, entity_id);
CREATE INDEX idx_tours_360_project ON public.tours_360 USING btree (project_id);
CREATE INDEX idx_user_cash_desk_desk_id ON public.user_cash_desk_access USING btree (cash_desk_id);
CREATE INDEX idx_user_cash_desk_user_id ON public.user_cash_desk_access USING btree (user_id);
CREATE INDEX idx_user_notifications_entity ON public.user_notifications USING btree (entity_type, entity_id);
CREATE INDEX idx_user_notifications_sales_plan_events ON public.user_notifications USING btree (event_type, created_at DESC);
CREATE INDEX idx_user_notifications_user_id_created ON public.user_notifications USING btree (user_id, created_at DESC);
CREATE INDEX idx_user_notifications_user_unread ON public.user_notifications USING btree (user_id, is_read) WHERE (is_read = false);
CREATE INDEX idx_users_is_sales_rep ON public.users USING btree (is_sales_rep) WHERE (is_sales_rep = true);
INSERT INTO public.crm_roles(code,name,is_system) VALUES ('ADMIN','Administrator',true),('DIRECTOR','Director',true),('SALES_MANAGER','Sales manager',true),('FINANCE_MANAGER','Finance manager',true),('MANAGER','Manager',true),('WAREHOUSE_MANAGER','Warehouse manager',true);
INSERT INTO public.crm_document_settings(id,data) VALUES(1,'{}'::jsonb);
INSERT INTO tozon_internal.customer_pko_counter(id,last_number) VALUES(1,0);
ALTER TABLE "public"."barter_realization_results" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."barter_realization_results" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."barter_realization_results" TO service_role;
ALTER TABLE "public"."buildings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."buildings" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."buildings" TO service_role;
ALTER TABLE "public"."cash_transfers" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."cash_transfers" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."cash_transfers" TO service_role;
ALTER TABLE "public"."construction_documents" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_documents" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_documents" TO service_role;
ALTER TABLE "public"."construction_expense_settlement_audit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_expense_settlement_audit" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_expense_settlement_audit" TO service_role;
ALTER TABLE "public"."construction_materials" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_materials" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_materials" TO service_role;
ALTER TABLE "public"."construction_parties" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_parties" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_parties" TO service_role;
ALTER TABLE "public"."construction_price_corrections" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_price_corrections" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_price_corrections" TO service_role;
ALTER TABLE "public"."construction_report_receipts" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_report_receipts" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_report_receipts" TO service_role;
ALTER TABLE "public"."construction_settings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_settings" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_settings" TO service_role;
ALTER TABLE "public"."construction_settlement_entries" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_settlement_entries" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_settlement_entries" TO service_role;
ALTER TABLE "public"."construction_stock_entries" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_stock_entries" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_stock_entries" TO service_role;
ALTER TABLE "public"."construction_warehouses" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."construction_warehouses" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."construction_warehouses" TO service_role;
ALTER TABLE "public"."cost_audit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."cost_audit" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."cost_audit" TO service_role;
ALTER TABLE "public"."cost_building_bases" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."cost_building_bases" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."cost_building_bases" TO service_role;
ALTER TABLE "public"."cost_expense_allocations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."cost_expense_allocations" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."cost_expense_allocations" TO service_role;
ALTER TABLE "public"."cost_material_audit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."cost_material_audit" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."cost_material_audit" TO service_role;
ALTER TABLE "public"."cost_material_payment_links" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."cost_material_payment_links" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."cost_material_payment_links" TO service_role;
ALTER TABLE "public"."cost_material_usages" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."cost_material_usages" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."cost_material_usages" TO service_role;
ALTER TABLE "public"."crm_document_settings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."crm_document_settings" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."crm_document_settings" TO service_role;
ALTER TABLE "public"."crm_document_settings_history" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."crm_document_settings_history" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."crm_document_settings_history" TO service_role;
ALTER TABLE "public"."crm_document_templates" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."crm_document_templates" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."crm_document_templates" TO service_role;
ALTER TABLE "public"."crm_roles" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."crm_roles" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."crm_roles" TO service_role;
ALTER TABLE "public"."deal_audit_logs" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."deal_audit_logs" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."deal_audit_logs" TO service_role;
ALTER TABLE "public"."deal_payment_schedules" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."deal_payment_schedules" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."deal_payment_schedules" TO service_role;
ALTER TABLE "public"."deals" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."deals" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."deals" TO service_role;
ALTER TABLE "public"."dictionaries" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."dictionaries" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."dictionaries" TO service_role;
ALTER TABLE "public"."discount_schemes" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."discount_schemes" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."discount_schemes" TO service_role;
ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."expenses" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."expenses" TO service_role;
ALTER TABLE "public"."finance_audit_backups" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."finance_audit_backups" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."finance_audit_backups" TO service_role;
ALTER TABLE "public"."floors" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."floors" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."floors" TO service_role;
ALTER TABLE "public"."identity_documents" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."identity_documents" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."identity_documents" TO service_role;
ALTER TABLE "public"."layout_features" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."layout_features" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."layout_features" TO service_role;
ALTER TABLE "public"."layout_rooms" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."layout_rooms" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."layout_rooms" TO service_role;
ALTER TABLE "public"."layout_types" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."layout_types" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."layout_types" TO service_role;
ALTER TABLE "public"."lead_assignment_history" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."lead_assignment_history" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."lead_assignment_history" TO service_role;
ALTER TABLE "public"."lead_distribution_settings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."lead_distribution_settings" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."lead_distribution_settings" TO service_role;
ALTER TABLE "public"."lead_interested_units" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."lead_interested_units" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."lead_interested_units" TO service_role;
ALTER TABLE "public"."lead_notes" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."lead_notes" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."lead_notes" TO service_role;
ALTER TABLE "public"."lead_status_history" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."lead_status_history" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."lead_status_history" TO service_role;
ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."leads" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."leads" TO service_role;
ALTER TABLE "public"."map_hotspots" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."map_hotspots" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."map_hotspots" TO service_role;
ALTER TABLE "public"."panorama_360" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."panorama_360" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."panorama_360" TO service_role;
ALTER TABLE "public"."panorama_hotspots" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."panorama_hotspots" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."panorama_hotspots" TO service_role;
ALTER TABLE "public"."passport_ai_audit_logs" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."passport_ai_audit_logs" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."passport_ai_audit_logs" TO service_role;
ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."payments" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."payments" TO service_role;
ALTER TABLE "public"."project_media" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."project_media" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."project_media" TO service_role;
ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."projects" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."projects" TO service_role;
ALTER TABLE "public"."sales_plan_alert_settings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."sales_plan_alert_settings" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."sales_plan_alert_settings" TO service_role;
ALTER TABLE "public"."sales_plan_audit_logs" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."sales_plan_audit_logs" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."sales_plan_audit_logs" TO service_role;
ALTER TABLE "public"."sales_plans" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."sales_plans" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."sales_plans" TO service_role;
ALTER TABLE "public"."scene_3d" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."scene_3d" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."scene_3d" TO service_role;
ALTER TABLE "public"."scene_3d_entities" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."scene_3d_entities" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."scene_3d_entities" TO service_role;
ALTER TABLE "public"."sections" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."sections" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."sections" TO service_role;
ALTER TABLE "public"."sms_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."sms_events" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."sms_events" TO service_role;
ALTER TABLE "public"."sms_messages" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."sms_messages" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."sms_messages" TO service_role;
ALTER TABLE "public"."sms_notification_rules" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."sms_notification_rules" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."sms_notification_rules" TO service_role;
ALTER TABLE "public"."sms_settings_history" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."sms_settings_history" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."sms_settings_history" TO service_role;
ALTER TABLE "public"."sms_templates" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."sms_templates" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."sms_templates" TO service_role;
ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."tasks" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."tasks" TO service_role;
ALTER TABLE "public"."telegram_finance_deliveries" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."telegram_finance_deliveries" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."telegram_finance_deliveries" TO service_role;
ALTER TABLE "public"."telegram_finance_expense_drafts" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."telegram_finance_expense_drafts" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."telegram_finance_expense_drafts" TO service_role;
ALTER TABLE "public"."telegram_finance_sessions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."telegram_finance_sessions" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."telegram_finance_sessions" TO service_role;
ALTER TABLE "public"."telegram_finance_sheet_outbox" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."telegram_finance_sheet_outbox" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."telegram_finance_sheet_outbox" TO service_role;
ALTER TABLE "public"."telegram_finance_state" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."telegram_finance_state" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."telegram_finance_state" TO service_role;
ALTER TABLE "public"."telegram_finance_subscribers" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."telegram_finance_subscribers" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."telegram_finance_subscribers" TO service_role;
ALTER TABLE "public"."telegram_finance_updates" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."telegram_finance_updates" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."telegram_finance_updates" TO service_role;
ALTER TABLE "public"."tours_360" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."tours_360" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."tours_360" TO service_role;
ALTER TABLE "public"."units" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."units" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."units" TO service_role;
ALTER TABLE "public"."user_cash_desk_access" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."user_cash_desk_access" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."user_cash_desk_access" TO service_role;
ALTER TABLE "public"."user_notifications" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."user_notifications" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."user_notifications" TO service_role;
ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."users" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."users" TO service_role;
ALTER TABLE "public"."visual_maps" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."visual_maps" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "public"."visual_maps" TO service_role;
ALTER TABLE "tozon_internal"."customer_pko_counter" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "tozon_internal"."customer_pko_counter" FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON "tozon_internal"."customer_pko_counter" TO service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, tozon_internal FROM PUBLIC, anon, authenticated;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public, tozon_internal TO service_role;
CREATE VIEW public.construction_expense_settlements WITH (security_invoker=true) AS
 SELECT id,settlement_party_id AS party_id,settlement_account AS account,currency,expense_date AS doc_date,
 amount_minor::numeric/100::numeric * CASE WHEN settlement_account IN ('PAYABLE','ADVANCE_RECEIVED') THEN -1 ELSE 1 END AS amount,
 reference,description,created_by_user_id,created_at FROM public.expenses
 WHERE settlement_party_id IS NOT NULL AND COALESCE(status,'ACTIVE')='ACTIVE' AND voided_at IS NULL;
REVOKE ALL ON public.construction_expense_settlements FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.construction_expense_settlements TO service_role;
`;
export const commercialExtendedFunctions = String.raw`-- Backend-only functions. No inherited SECURITY DEFINER privileges or public execution.
SET LOCAL check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.activate_crm_document_template(p_actor bigint, p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_row public.crm_document_templates;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND role='ADMIN' AND is_active=1) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 -- Serialize changes to slots, including activating a historical revision.
 PERFORM 1 FROM public.crm_document_settings WHERE id=1 FOR UPDATE;
 SELECT * INTO v_row FROM public.crm_document_templates WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'TEMPLATE_NOT_FOUND'; END IF;
 UPDATE public.crm_document_templates SET active=false WHERE kind=v_row.kind AND language=v_row.language AND scope=v_row.scope AND active;
 UPDATE public.crm_document_templates SET active=true WHERE id=p_id;
END $function$;
ALTER FUNCTION "public"."activate_crm_document_template"(p_actor bigint, p_id uuid) SECURITY INVOKER;
ALTER FUNCTION "public"."activate_crm_document_template"(p_actor bigint, p_id uuid) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."activate_crm_document_template"(p_actor bigint, p_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."activate_crm_document_template"(p_actor bigint, p_id uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.amend_deal_atomic(p_deal_id bigint, p_user_id bigint, p_amendment jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 d public.deals%ROWTYPE; u public.units%ROWTYPE;
 old_deal jsonb; old_schedules jsonb; result jsonb; old_unit jsonb;
 target_id bigint; price bigint; rate bigint; plan bigint; n bigint; old_plan numeric;
 down_pmt bigint; barter bigint; payment_kind text; field_name text;
 paid bigint; pool bigint; allocated bigint; previous_total numeric := 0; next_total numeric;
 amount bigint; sched record; old_project bigint; new_project bigint; new_currency text;
 today text := to_char(now() AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM-DD');
 stamp text := clock_timestamp()::text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_user_id AND role='ADMIN' AND is_active=1) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Изменение доступно только действующему администратору';
 END IF;
 IF jsonb_typeof(p_amendment) IS DISTINCT FROM 'object' OR
    EXISTS (SELECT 1 FROM jsonb_object_keys(p_amendment) k WHERE k NOT IN
      ('unit_id','final_price_minor','deal_price_per_m2_minor','reason','expected_updated_at','down_payment_minor','payment_type','barter_amount_minor','barter_description','vehicle_details')) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Недопустимые поля';
 END IF;
 IF nullif(btrim(p_amendment->>'reason'),'') IS NULL OR length(p_amendment->>'reason')>2000 THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Укажите причину изменения';
 END IF;
 target_id := (p_amendment->>'unit_id')::bigint;
 price := (p_amendment->>'final_price_minor')::bigint;
 rate := (p_amendment->>'deal_price_per_m2_minor')::bigint;
 IF target_id IS NULL OR price IS NULL OR rate IS NULL OR target_id<=0 OR price<=0 OR rate<=0
    OR price>2147483647 OR rate>2147483647 THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Неверные квартира или стоимость';
 END IF;
 SELECT * INTO d FROM public.deals WHERE id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DEAL_NOT_FOUND'; END IF;
 IF d.status NOT IN ('RESERVED','SIGNED') OR d.payment_type NOT IN ('FULL','INSTALLMENT','PARTIAL_BARTER') THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Изменение доступно для активной продажи или брони';
 END IF;
 IF p_amendment->>'expected_updated_at' IS NULL OR
    d.updated_at::timestamptz IS DISTINCT FROM (p_amendment->>'expected_updated_at')::timestamptz THEN
   RAISE EXCEPTION 'STALE_DEAL';
 END IF;
 FOREACH field_name IN ARRAY ARRAY['down_payment_minor','barter_amount_minor'] LOOP
   IF p_amendment ? field_name AND (jsonb_typeof(p_amendment->field_name) IS DISTINCT FROM 'number'
      OR (p_amendment->>field_name) !~ '^[0-9]+$' OR (p_amendment->>field_name)::numeric>2147483647) THEN
     RAISE EXCEPTION 'AMENDMENT_INVALID: Неверная сумма первоначального взноса или бартера';
   END IF;
 END LOOP;
 down_pmt := coalesce((p_amendment->>'down_payment_minor')::bigint,d.down_payment_minor,0);
 barter := coalesce((p_amendment->>'barter_amount_minor')::bigint,d.barter_amount_minor,0);
 payment_kind := coalesce(p_amendment->>'payment_type',d.payment_type);
 IF payment_kind IS NULL OR (payment_kind<>d.payment_type AND NOT
    (d.payment_type IN ('INSTALLMENT','FULL') AND payment_kind='PARTIAL_BARTER')) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Допустимо только добавление автомобиля к действующему договору';
 END IF;
 IF down_pmt<0 OR down_pmt>price OR barter<0 OR barter>down_pmt THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Стоимость автомобиля должна входить в первый взнос, а первый взнос не может превышать цену договора';
 END IF;
 IF payment_kind<>'PARTIAL_BARTER' AND (barter>0 OR p_amendment ? 'vehicle_details' OR p_amendment ? 'barter_description') THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Автомобиль доступен для формы Бартер + Доплата';
 END IF;
 IF d.payment_type<>'PARTIAL_BARTER' AND payment_kind='PARTIAL_BARTER' AND (barter<=0 OR nullif(btrim(p_amendment->>'barter_description'),'') IS NULL) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Укажите описание и положительную стоимость автомобиля';
 END IF;
 IF p_amendment ? 'barter_description' AND (jsonb_typeof(p_amendment->'barter_description') IS DISTINCT FROM 'string' OR length(p_amendment->>'barter_description')>2000) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Неверное описание бартера';
 END IF;
 IF p_amendment ? 'vehicle_details' AND p_amendment->'vehicle_details'<>'null'::jsonb THEN
   IF jsonb_typeof(p_amendment->'vehicle_details') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'AMENDMENT_INVALID: Неверные данные автомобиля'; END IF;
   IF EXISTS (SELECT 1 FROM jsonb_each(p_amendment->'vehicle_details') e
      WHERE e.key NOT IN ('brand_model','production_year','color','registration_number','vin','registration_certificate','mileage_km','handover_date','condition','accessories','encumbrances')
      OR jsonb_typeof(e.value) IS DISTINCT FROM 'string' OR length(e.value #>> '{}')>1000) THEN
     RAISE EXCEPTION 'AMENDMENT_INVALID: Недопустимые данные автомобиля';
   END IF;
 END IF;
 old_deal := to_jsonb(d);
 -- Deterministic unit locks prevent competing swaps and sales from partially updating the board.
 PERFORM id FROM public.units WHERE id IN (d.unit_id,target_id) ORDER BY id FOR UPDATE;
 SELECT to_jsonb(x) INTO old_unit FROM public.units x WHERE id=d.unit_id;
 SELECT * INTO u FROM public.units WHERE id=target_id;
 IF NOT FOUND OR u.archived_at IS NOT NULL OR u.area_m2_x100<=0 THEN
   RAISE EXCEPTION 'UNIT_UNAVAILABLE';
 END IF;
 IF target_id<>d.unit_id AND (u.status<>'AVAILABLE' OR EXISTS
    (SELECT 1 FROM public.deals WHERE unit_id=target_id AND id<>d.id AND status IN ('RESERVED','SIGNED'))) THEN
   RAISE EXCEPTION 'UNIT_UNAVAILABLE';
 END IF;
 SELECT b.project_id INTO old_project FROM public.units x JOIN public.floors f ON f.id=x.floor_id
 JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id WHERE x.id=d.unit_id;
 SELECT b.project_id,p.currency INTO new_project,new_currency FROM public.floors f
 JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id
 JOIN public.projects p ON p.id=b.project_id WHERE f.id=u.floor_id;
 IF old_project IS NULL OR new_project IS DISTINCT FROM old_project OR new_currency IS DISTINCT FROM d.currency THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Выберите квартиру в том же проекте и валюте';
 END IF;
 IF price+d.discount_minor>2147483647 OR price<down_pmt THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Стоимость ниже договорного первого взноса или превышает допустимую сумму';
 END IF;
 PERFORM id FROM public.payments WHERE deal_id=d.id ORDER BY id FOR UPDATE;
 PERFORM id FROM public.deal_payment_schedules WHERE deal_id=d.id ORDER BY id FOR UPDATE;
 SELECT coalesce(sum(amount_minor),0) INTO paid FROM public.payments
 WHERE deal_id=d.id AND status IN ('ACTIVE','POSTED');
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.due_date,x.id),'[]'::jsonb),count(*),coalesce(sum(x.amount_minor),0)
 INTO old_schedules,n,old_plan FROM public.deal_payment_schedules x WHERE deal_id=d.id;
 plan := price-down_pmt;
 IF payment_kind IN ('INSTALLMENT','PARTIAL_BARTER') AND plan>0 AND n=0 THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Сначала восстановите график рассрочки';
 END IF;
 IF n>0 AND (plan<n OR old_plan<=0) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Сумма графика слишком мала; требуется отдельное согласование графика';
 END IF;
 UPDATE public.deals SET unit_id=target_id,final_price_minor=price,
 base_price_minor=price+discount_minor,deal_price_per_m2_minor=rate,down_payment_minor=down_pmt,payment_type=payment_kind,
 barter_amount_minor=barter,
 barter_description=CASE WHEN p_amendment ? 'barter_description' THEN nullif(btrim(p_amendment->>'barter_description'),'') ELSE barter_description END,
 vehicle_details=CASE WHEN p_amendment ? 'vehicle_details' THEN nullif(p_amendment->'vehicle_details','null'::jsonb) ELSE vehicle_details END,
 updated_at=stamp WHERE id=d.id;
 IF target_id<>d.unit_id THEN
   UPDATE public.units SET status='AVAILABLE',updated_at=stamp WHERE id=d.unit_id;
   UPDATE public.units SET status=CASE WHEN d.status='SIGNED' THEN 'SOLD' ELSE 'RESERVED' END,
   updated_at=stamp WHERE id=target_id;
 END IF;
 -- Keep schedule IDs (including payment FK references), dates and row count. Rescale agreed
 -- amounts proportionally, reserve one cent per row, and assign rounding by cumulative totals.
 pool := greatest(0,paid-down_pmt);
 FOR sched IN SELECT * FROM public.deal_payment_schedules WHERE deal_id=d.id ORDER BY due_date,id LOOP
   next_total := previous_total+sched.amount_minor;
   amount := 1+floor((plan-n)::numeric*next_total/old_plan)-floor((plan-n)::numeric*previous_total/old_plan);
   allocated := least(amount,pool); pool:=pool-allocated;
   UPDATE public.deal_payment_schedules SET amount_minor=amount,paid_amount_minor=allocated,
   status=CASE WHEN allocated>=amount THEN 'PAID' WHEN allocated>0 THEN 'PARTIAL'
     WHEN due_date<today THEN 'OVERDUE' ELSE 'UPCOMING' END,updated_at=stamp WHERE id=sched.id;
   previous_total:=next_total;
 END LOOP;
 SELECT to_jsonb(x) INTO result FROM public.deals x WHERE id=d.id;
 INSERT INTO public.deal_audit_logs(deal_id,user_id,action,changes_json)
 VALUES(d.id,p_user_id,'AMEND_CONTRACT',jsonb_build_object('reason',btrim(p_amendment->>'reason'),
   'old',old_deal,'new',result,'old_unit',old_unit,'new_unit',to_jsonb(u),'old_schedules',old_schedules,
   'new_schedules',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.due_date,x.id),'[]'::jsonb)
     FROM public.deal_payment_schedules x WHERE x.deal_id=d.id),
   'paid_minor',paid,'remaining_minor',greatest(0,price-paid),'overpayment_minor',greatest(0,paid-price)));
 RETURN result;
END;
$function$;
ALTER FUNCTION "public"."amend_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_amendment jsonb) SECURITY INVOKER;
ALTER FUNCTION "public"."amend_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_amendment jsonb) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."amend_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_amendment jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."amend_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_amendment jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.construction_audit_expense_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare before_row jsonb; after_row jsonb;
begin
 if tg_op<>'INSERT' then before_row=to_jsonb(old); end if;
 if tg_op<>'DELETE' then after_row=to_jsonb(new); end if;
 if coalesce(before_row->>'settlement_party_id',after_row->>'settlement_party_id') is not null
 and (tg_op<>'UPDATE' or (before_row-array['reference','updated_at','settlement_updated_by']) is distinct from (after_row-array['reference','updated_at','settlement_updated_by'])) then
  insert into public.construction_expense_settlement_audit(expense_id,actor_id,operation,before_data,after_data)
  values(coalesce((after_row->>'id')::integer,(before_row->>'id')::integer),case when tg_op='DELETE' then null else (after_row->>'settlement_updated_by')::integer end,tg_op,before_row,after_row);
 end if;
 return coalesce(new,old);
end $function$;
ALTER FUNCTION "public"."construction_audit_expense_settlement"() SECURITY INVOKER;
ALTER FUNCTION "public"."construction_audit_expense_settlement"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."construction_audit_expense_settlement"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."construction_audit_expense_settlement"() TO service_role;
CREATE OR REPLACE FUNCTION public.construction_cash_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM construction_documents WHERE status='POSTED' AND ((TG_TABLE_NAME='expenses' AND expense_id=OLD.id) OR (TG_TABLE_NAME='payments' AND payment_id=OLD.id))) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Кассовый документ связан с проведённым строительным учётом'; END IF;
  IF (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RAISE EXCEPTION 'Кассовый документ связан с проведённым строительным учётом'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $function$;
ALTER FUNCTION "public"."construction_cash_guard"() SECURITY INVOKER;
ALTER FUNCTION "public"."construction_cash_guard"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."construction_cash_guard"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."construction_cash_guard"() TO service_role;
CREATE OR REPLACE FUNCTION public.construction_correct_receipt_price(p_id uuid, p_receipt uuid, p_values jsonb, p_expected integer, p_reason text, p_actor integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 d public.construction_documents; u public.users; previous public.construction_price_corrections;
 entry record; prior record; usage public.cost_material_usages; after_usage public.cost_material_usages;
 old_lines jsonb; new_lines jsonb; changes jsonb:='[]'; version_now integer;
 pos integer:=0; val numeric; qty numeric; balance_value numeric; total numeric; old_total numeric; old_payable numeric;
 result jsonb;
begin
 select * into u from public.users where id=p_actor and to_jsonb(users)->>'is_active' in ('true','1');
 if not found or not (u.role='ADMIN' or coalesce(u.permissions::jsonb,'[]') ?| array['*','construction.settings']) then
  raise exception 'Недостаточно прав для корректировки цены' using errcode='42501';
 end if;
 -- Same posting lock and same cost lock as the existing writers.
 perform 1 from public.construction_settings where id=1 for update;
 perform pg_catalog.pg_advisory_xact_lock(6101803,1);
 select * into d from public.construction_documents where id=p_receipt for update;
 if not found or d.kind<>'RECEIPT' or d.status<>'POSTED' then raise exception 'Выберите проведённое поступление материалов'; end if;
 select * into previous from public.construction_price_corrections where id=p_id;
 if found then
  if previous.receipt_id<>p_receipt or previous.actor_id<>p_actor or previous.reason<>trim(p_reason)
   or (select jsonb_agg(l->'value' order by n) from jsonb_array_elements(previous.after_lines) with ordinality a(l,n)) is distinct from p_values
  then raise exception 'Идентификатор корректировки уже использован'; end if;
  return to_jsonb(previous);
 end if;
 select coalesce(max(version),0) into version_now from public.construction_price_corrections where receipt_id=p_receipt;
 if p_expected is null or p_expected<>version_now then raise exception 'VERSION_CONFLICT: Цена уже изменена. Обновите данные' using errcode='40001'; end if;
 if p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'Укажите причину корректировки (3–2000 символов)'; end if;
 if jsonb_typeof(p_values) is distinct from 'array' or jsonb_array_length(p_values)<>jsonb_array_length(d.lines) then raise exception 'Состав строк изменён. Обновите данные'; end if;
 if exists(select 1 from public.construction_report_receipts where receipt_id=p_receipt) then raise exception 'Поступление включено в утверждённый авансовый отчёт. Требуется отдельная корректировка отчёта'; end if;
 select after_lines into old_lines from public.construction_price_corrections where receipt_id=p_receipt order by version desc limit 1;
 old_lines=coalesce(old_lines,d.lines); new_lines=old_lines;
 if (select count(*) from public.construction_stock_entries where document_id=p_receipt)<>jsonb_array_length(d.lines) then raise exception 'Проводки не соответствуют строкам поступления'; end if;
 for entry in select * from public.construction_stock_entries where document_id=p_receipt order by id loop
  if jsonb_typeof(p_values->pos) is distinct from 'number' then raise exception 'Укажите стоимость каждой строки'; end if;
  val=(p_values->>pos)::numeric;
  if val<0 or val>999999999999 or val<>round(val,2) then raise exception 'Стоимость должна быть неотрицательной, до двух знаков после запятой'; end if;
  if entry.quantity<=0 or entry.material_id::text is distinct from d.lines->pos->>'material_id'
    or entry.quantity<>(d.lines->pos->>'quantity')::numeric then raise exception 'Проводки не соответствуют строкам поступления'; end if;
  new_lines=jsonb_set(new_lines,array[pos::text,'value'],to_jsonb(val));
  if val<>entry.value then
   changes=changes||jsonb_build_array(jsonb_build_object('entry_id',entry.id,'before',entry.value,'after',val));
   update public.construction_stock_entries set value=val where id=entry.id;
  end if;
  pos=pos+1;
 end loop;
 if changes='[]'::jsonb then raise exception 'Цена не изменена'; end if;
 select sum((l->>'value')::numeric) into total from jsonb_array_elements(new_lines) l;
 select sum((l->>'value')::numeric) into old_total from jsonb_array_elements(old_lines) l;
 -- Replay weighted-average valuation in original posting order, across warehouses.
 -- Transfer pairs are inserted consecutively by construction_post.
 for entry in
  select e.*,doc.kind from public.construction_stock_entries e join public.construction_documents doc on doc.id=e.document_id
  where e.currency=d.currency and e.material_id in (select (l->>'material_id')::uuid from jsonb_array_elements(d.lines) l)
  order by e.id
 loop
  val=entry.value;
  if entry.quantity<0 then
   select coalesce(sum(quantity),0),coalesce(sum(value),0) into qty,balance_value from public.construction_stock_entries
    where warehouse_id=entry.warehouse_id and material_id=entry.material_id and currency=entry.currency and id<entry.id;
   if qty< -entry.quantity or qty<=0 or balance_value<0 then raise exception 'Нарушена последовательность складских проводок'; end if;
   val=case when qty= -entry.quantity then -balance_value else -round(balance_value*(-entry.quantity)/qty,2) end;
  elsif entry.kind='TRANSFER' then
   select * into prior from public.construction_stock_entries where id=entry.id-1;
   if prior.document_id is distinct from entry.document_id or prior.material_id is distinct from entry.material_id
     or prior.quantity<> -entry.quantity or prior.currency<>entry.currency then raise exception 'Не найдена парная проводка перемещения'; end if;
   val= -prior.value;
  end if;
  if val<>entry.value then
   changes=changes||jsonb_build_array(jsonb_build_object('entry_id',entry.id,'before',entry.value,'after',val));
   update public.construction_stock_entries set value=val where id=entry.id;
   for usage in select * from public.cost_material_usages where stock_entry_id=entry.id for update loop
    if val>=0 then raise exception 'Связанный расход себестоимости не может иметь нулевую стоимость'; end if;
    if exists(select 1 from public.cost_material_payment_links where usage_id=usage.id and status='ACTIVE') then
     raise exception 'Сначала отмените привязки оплат в себестоимости, затем корректируйте цену поступления';
    end if;
    update public.cost_material_usages set amount= -val,version=version+1,updated_by=p_actor,updated_at=now() where id=usage.id returning * into after_usage;
    insert into public.cost_material_audit(entity,entity_id,before_data,after_data,actor_id) values('USAGE',usage.id,to_jsonb(usage),to_jsonb(after_usage),p_actor);
   end loop;
  end if;
 end loop;
 if (select kind from public.construction_parties where id=d.party_id)<>'EMPLOYEE' then
  select coalesce(sum(amount),0) into old_payable from public.construction_settlement_entries where document_id=p_receipt and account='PAYABLE';
  if old_payable<>old_total then raise exception 'Начисление поставщику не соответствует поступлению'; end if;
  delete from public.construction_settlement_entries where document_id=p_receipt and account='PAYABLE';
  if total>0 then insert into public.construction_settlement_entries(document_id,party_id,currency,account,amount) values(p_receipt,d.party_id,d.currency,'PAYABLE',total); end if;
 end if;
 insert into public.construction_price_corrections(id,receipt_id,version,reason,actor_id,before_lines,after_lines,ledger_changes)
 values(p_id,p_receipt,version_now+1,trim(p_reason),p_actor,old_lines,new_lines,changes) returning to_jsonb(construction_price_corrections) into result;
 return result;
end $function$;
ALTER FUNCTION "public"."construction_correct_receipt_price"(p_id uuid, p_receipt uuid, p_values jsonb, p_expected integer, p_reason text, p_actor integer) SECURITY INVOKER;
ALTER FUNCTION "public"."construction_correct_receipt_price"(p_id uuid, p_receipt uuid, p_values jsonb, p_expected integer, p_reason text, p_actor integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."construction_correct_receipt_price"(p_id uuid, p_receipt uuid, p_values jsonb, p_expected integer, p_reason text, p_actor integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."construction_correct_receipt_price"(p_id uuid, p_receipt uuid, p_values jsonb, p_expected integer, p_reason text, p_actor integer) TO service_role;
CREATE OR REPLACE FUNCTION public.construction_document_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF OLD.status='POSTED' THEN RAISE EXCEPTION 'Проведённый документ неизменяем'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $function$;
ALTER FUNCTION "public"."construction_document_guard"() SECURITY INVOKER;
ALTER FUNCTION "public"."construction_document_guard"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."construction_document_guard"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."construction_document_guard"() TO service_role;
CREATE OR REPLACE FUNCTION public.construction_post(p_id uuid, p_actor integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE d construction_documents; u users; cfg construction_settings; l jsonb; mid uuid; q numeric; v numeric; qty numeric; val numeric;
 total numeric:=0; e jsonb; acct text; sign integer:=1; receipt construction_documents; amount_value numeric; is_admin boolean;
BEGIN
 SELECT * INTO u FROM users WHERE id=p_actor AND to_jsonb(users)->>'is_active' IN ('true','1');
 IF NOT FOUND THEN RAISE EXCEPTION 'Нет доступа'; END IF;
 is_admin:=u.role='ADMIN' OR coalesce(u.permissions::jsonb,'[]') ? '*';
 SELECT * INTO cfg FROM construction_settings WHERE id=1 FOR UPDATE;
 SELECT * INTO d FROM construction_documents WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Документ не найден'; END IF;
 IF d.status='POSTED' THEN
  IF NOT is_admin AND NOT (coalesce(u.permissions::jsonb,'[]') ? CASE WHEN d.kind IN ('OPENING_STOCK','RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF') THEN 'construction.stock' WHEN d.kind LIKE '%ADVANCE%' THEN 'construction.advance' ELSE 'construction.settlements' END) THEN RAISE EXCEPTION 'Недостаточно прав'; END IF;
  RETURN to_jsonb(d);
 END IF;
 IF d.status='CANCELLED' THEN RAISE EXCEPTION 'Документ отменён'; END IF;
 IF d.doc_date<cfg.start_date THEN RAISE EXCEPTION 'Дата раньше начала учёта'; END IF;
 IF d.kind LIKE 'OPENING_%' AND d.doc_date<>cfg.start_date THEN RAISE EXCEPTION 'Начальный остаток должен быть на дату начала учёта'; END IF;
 IF d.kind='ADVANCE_REPORT' THEN
  IF cfg.approver_user_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Авансовый отчёт утверждает назначенный руководитель'; END IF;
  IF d.status<>'SUBMITTED' THEN RAISE EXCEPTION 'Отчёт ещё не отправлен на утверждение'; END IF;
 ELSIF NOT is_admin AND NOT (coalesce(u.permissions::jsonb,'[]') ? CASE WHEN d.kind IN ('OPENING_STOCK','RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF') THEN 'construction.stock' WHEN d.kind LIKE '%ADVANCE%' THEN 'construction.advance' ELSE 'construction.settlements' END) THEN
  RAISE EXCEPTION 'Недостаточно прав';
 END IF;
 IF d.kind LIKE 'OPENING_%' AND NOT is_admin THEN RAISE EXCEPTION 'Начальные остатки вводит администратор'; END IF;
 IF NOT is_admin AND d.kind IN ('ADVANCE_ISSUE','ADVANCE_RETURN','ADVANCE_REIMBURSE') AND NOT(coalesce(u.permissions::jsonb,'[]') ? 'construction.settlements') THEN RAISE EXCEPTION 'Выдачу и возврат подтверждает финансовый сотрудник'; END IF;
 IF d.party_id IS NOT NULL THEN
  PERFORM id FROM construction_parties WHERE id=d.party_id AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Контрагент неактивен'; END IF;
 END IF;
 IF (d.expense_id IS NOT NULL OR d.payment_id IS NOT NULL) AND d.kind NOT IN ('SETTLEMENT_PAYMENT','ADVANCE_ISSUE','ADVANCE_RETURN','ADVANCE_REIMBURSE') THEN RAISE EXCEPTION 'ПКО/РКО связывается только с денежной операцией'; END IF;
 -- Link a previously posted cash document, never create a second cash movement.
 IF d.kind IN ('SETTLEMENT_PAYMENT','ADVANCE_ISSUE','ADVANCE_RETURN','ADVANCE_REIMBURSE') THEN
  IF d.expense_id IS NULL AND d.payment_id IS NULL THEN RAISE EXCEPTION 'Укажите существующий ПКО или РКО'; END IF;
  IF d.kind IN ('ADVANCE_ISSUE','ADVANCE_REIMBURSE') AND d.expense_id IS NULL THEN RAISE EXCEPTION 'Нужен РКО'; END IF;
  IF d.kind='ADVANCE_RETURN' AND d.payment_id IS NULL THEN RAISE EXCEPTION 'Нужен ПКО'; END IF;
  IF d.kind='SETTLEMENT_PAYMENT' AND ((d.balance_type IN ('PAYABLE','ADVANCE_GIVEN') AND d.expense_id IS NULL) OR (d.balance_type IN ('RECEIVABLE','ADVANCE_RECEIVED') AND d.payment_id IS NULL)) THEN RAISE EXCEPTION 'Неверное направление оплаты'; END IF;
  IF d.expense_id IS NOT NULL THEN SELECT to_jsonb(x) INTO e FROM expenses x WHERE id=d.expense_id FOR UPDATE;
  ELSE SELECT to_jsonb(x) INTO e FROM payments x WHERE id=d.payment_id FOR UPDATE; END IF;
  IF e IS NULL OR coalesce(e->>'status','ACTIVE')<>'ACTIVE' OR e->>'voided_at' IS NOT NULL OR e->>'transfer_id' IS NOT NULL OR e->>'conversion_id' IS NOT NULL OR e->>'conversion_expense_id' IS NOT NULL OR coalesce(e->>'operation_type','STANDARD') NOT IN ('STANDARD','EXPENSE','INCOME') THEN RAISE EXCEPTION 'Нужен действующий ПКО/РКО без перемещения или конвертации'; END IF;
  IF e->>'currency'<>d.currency OR (e->>'amount_minor')::numeric<>d.amount*100 THEN RAISE EXCEPTION 'Сумма или валюта не совпадает с кассовым документом'; END IF;
  IF left(coalesce(e->>CASE WHEN d.expense_id IS NULL THEN 'payment_date' ELSE 'expense_date' END,''),10)<>d.doc_date::text THEN RAISE EXCEPTION 'Дата должна совпадать с кассовым документом'; END IF;
 END IF;
 IF d.kind IN ('OPENING_STOCK','RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF') THEN
  IF d.warehouse_id IS NULL OR jsonb_array_length(d.lines)=0 THEN RAISE EXCEPTION 'Укажите склад и материалы'; END IF;
  PERFORM id FROM construction_warehouses WHERE id=d.warehouse_id AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Склад неактивен'; END IF;
  IF d.kind='TRANSFER' THEN
   IF d.destination_id IS NULL OR d.destination_id=d.warehouse_id THEN RAISE EXCEPTION 'Укажите другой склад'; END IF;
   PERFORM id FROM construction_warehouses WHERE id=d.destination_id AND active FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Склад назначения неактивен'; END IF;
  END IF;
  IF d.kind IN ('ISSUE','WRITE_OFF') AND (d.project_id IS NULL OR coalesce(trim(d.work_type),'')='') THEN RAISE EXCEPTION 'Укажите объект и вид работ'; END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(d.lines) LOOP
   mid:=(l->>'material_id')::uuid; q:=(l->>'quantity')::numeric;
   IF q IS NULL OR q<=0 OR q<>round(q,4) THEN RAISE EXCEPTION 'Количество должно быть положительным, до 4 знаков'; END IF;
   PERFORM id FROM construction_materials WHERE id=mid AND active;
   IF NOT FOUND THEN RAISE EXCEPTION 'Материал не найден или неактивен'; END IF;
   IF EXISTS(SELECT 1 FROM construction_stock_entries s JOIN construction_documents x ON x.id=s.document_id WHERE s.material_id=mid AND s.currency=d.currency AND s.warehouse_id IN (d.warehouse_id,d.destination_id) AND (x.doc_date>d.doc_date OR (d.kind='OPENING_STOCK' AND x.kind<>'OPENING_STOCK'))) THEN RAISE EXCEPTION 'Нельзя провести задним числом: сначала остатки, затем движение по датам'; END IF;
   SELECT coalesce(sum(quantity),0),coalesce(sum(value),0) INTO qty,val FROM construction_stock_entries WHERE warehouse_id=d.warehouse_id AND material_id=mid AND currency=d.currency;
   IF d.kind IN ('ISSUE','TRANSFER','WRITE_OFF') THEN
    IF qty<q THEN RAISE EXCEPTION 'Недостаточно материала на складе в выбранной валюте'; END IF;
    v:=CASE WHEN q=qty THEN val ELSE round(val*q/qty,2) END;
    INSERT INTO construction_stock_entries(document_id,warehouse_id,material_id,currency,quantity,value) VALUES(d.id,d.warehouse_id,mid,d.currency,-q,-v);
    IF d.kind='TRANSFER' THEN INSERT INTO construction_stock_entries(document_id,warehouse_id,material_id,currency,quantity,value) VALUES(d.id,d.destination_id,mid,d.currency,q,v); END IF;
   ELSE
    v:=round((l->>'value')::numeric,2);
    IF v IS NULL OR v<0 THEN RAISE EXCEPTION 'Укажите стоимость материала'; END IF;
    INSERT INTO construction_stock_entries(document_id,warehouse_id,material_id,currency,quantity,value) VALUES(d.id,d.warehouse_id,mid,d.currency,q,v);
   END IF;
   total:=total+v;
  END LOOP;
  -- Receipt with supplier creates payable; employee-funded receipt is settled by advance report.
  IF d.kind='RECEIPT' THEN
   IF d.party_id IS NULL THEN RAISE EXCEPTION 'Укажите поставщика или подотчётное лицо'; END IF;
   IF NOT EXISTS(SELECT 1 FROM construction_parties WHERE id=d.party_id AND kind='EMPLOYEE') AND total>0 THEN INSERT INTO construction_settlement_entries(document_id,party_id,currency,account,amount) VALUES(d.id,d.party_id,d.currency,'PAYABLE',total); END IF;
  END IF;
 ELSIF d.kind='ADVANCE_REPORT' THEN
  IF d.party_id IS NULL OR NOT EXISTS(SELECT 1 FROM construction_parties WHERE id=d.party_id AND kind='EMPLOYEE') OR jsonb_array_length(d.lines)=0 THEN RAISE EXCEPTION 'Укажите подотчётное лицо и расходы'; END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(d.lines) LOOP
   IF coalesce(trim(l->>'basis'),'')='' OR coalesce(trim(l->>'proof'),'')='' THEN RAISE EXCEPTION 'Укажите назначение и подтверждающий документ'; END IF;
   IF l->>'receipt_id' IS NOT NULL AND l->>'receipt_id'<>'' THEN
    SELECT * INTO receipt FROM construction_documents WHERE id=(l->>'receipt_id')::uuid;
    IF NOT FOUND OR receipt.status<>'POSTED' OR receipt.kind<>'RECEIPT' OR receipt.party_id<>d.party_id OR receipt.currency<>d.currency OR receipt.doc_date>d.doc_date THEN RAISE EXCEPTION 'Поступление не соответствует подотчётному отчёту'; END IF;
    SELECT sum(value) INTO amount_value FROM construction_stock_entries WHERE document_id=receipt.id;
    IF amount_value<>(l->>'amount')::numeric THEN RAISE EXCEPTION 'Сумма строки не совпадает с поступлением'; END IF;
    INSERT INTO construction_report_receipts(receipt_id,report_id) VALUES(receipt.id,d.id);
   END IF;
   amount_value:=(l->>'amount')::numeric;
   IF amount_value IS NULL OR amount_value<=0 OR amount_value<>round(amount_value,2) THEN RAISE EXCEPTION 'Некорректная сумма расхода'; END IF;
   total:=total+amount_value;
  END LOOP;
  INSERT INTO construction_settlement_entries(document_id,party_id,currency,account,amount) VALUES(d.id,d.party_id,d.currency,'EMPLOYEE',-total);
 ELSE
  IF d.party_id IS NULL OR d.amount IS NULL THEN RAISE EXCEPTION 'Укажите лицо и сумму'; END IF;
  IF d.kind LIKE '%ADVANCE%' THEN
   IF NOT EXISTS(SELECT 1 FROM construction_parties WHERE id=d.party_id AND kind='EMPLOYEE') THEN RAISE EXCEPTION 'Выберите подотчётное лицо'; END IF;
   acct:='EMPLOYEE'; sign:=CASE WHEN d.kind='ADVANCE_RETURN' THEN -1 ELSE 1 END;
   -- Negative opening balance represents employee overrun owed by company.
   IF d.kind='OPENING_ADVANCE' AND d.balance_type='PAYABLE' THEN sign:=-1; END IF;
  ELSE
   acct:=d.balance_type;
   IF acct IS NULL THEN RAISE EXCEPTION 'Укажите вид задолженности'; END IF;
   sign:=CASE WHEN d.kind='SETTLEMENT_PAYMENT' AND acct IN ('RECEIVABLE','PAYABLE') THEN -1 ELSE 1 END;
  END IF;
  IF d.kind LIKE 'OPENING_%' AND EXISTS(SELECT 1 FROM construction_settlement_entries s JOIN construction_documents x ON x.id=s.document_id WHERE s.party_id=d.party_id AND s.currency=d.currency AND s.account=acct AND x.kind NOT LIKE 'OPENING_%') THEN RAISE EXCEPTION 'Начальный остаток вводится до движения'; END IF;
  INSERT INTO construction_settlement_entries(document_id,party_id,currency,account,amount) VALUES(d.id,d.party_id,d.currency,acct,d.amount*sign);
 END IF;
 UPDATE construction_documents SET status='POSTED',posted_by=p_actor,posted_at=now() WHERE id=d.id RETURNING * INTO d;
 RETURN to_jsonb(d);
END $function$;
ALTER FUNCTION "public"."construction_post"(p_id uuid, p_actor integer) SECURITY INVOKER;
ALTER FUNCTION "public"."construction_post"(p_id uuid, p_actor integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."construction_post"(p_id uuid, p_actor integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."construction_post"(p_id uuid, p_actor integer) TO service_role;
CREATE OR REPLACE FUNCTION public.construction_prevent_double_expense_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare party uuid;
begin
 if new.expense_id is not null and new.status<>'CANCELLED' then
  select settlement_party_id into party from public.expenses where id=new.expense_id for update;
  if party is not null then raise exception 'Этот РКО уже автоматически учтён в расчётах с контрагентом'; end if;
 end if;
 if new.kind='OPENING_SETTLEMENT' and new.status='POSTED' and exists(select 1 from public.construction_expense_settlements where party_id=new.party_id and currency=new.currency and account=new.balance_type) then
  raise exception 'Начальный остаток вводится до движения по РКО';
 end if;
 return new;
end $function$;
ALTER FUNCTION "public"."construction_prevent_double_expense_settlement"() SECURITY INVOKER;
ALTER FUNCTION "public"."construction_prevent_double_expense_settlement"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."construction_prevent_double_expense_settlement"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."construction_prevent_double_expense_settlement"() TO service_role;
CREATE OR REPLACE FUNCTION public.construction_validate_expense_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if new.settlement_party_id is not null then
  if not exists(select 1 from public.construction_parties where id=new.settlement_party_id and kind<>'EMPLOYEE' and active) then
   -- Archiving a party must not prevent voiding an existing cash document.
   if tg_op='INSERT' or new.settlement_party_id is distinct from old.settlement_party_id or coalesce(new.status,'ACTIVE')='ACTIVE' and new.voided_at is null then
    raise exception 'Выберите активного поставщика, подрядчика или дебитора';
   end if;
  end if;
  if new.currency not in ('TJS','USD') or new.amount_minor<=0 or new.expense_date<(select start_date from public.construction_settings where id=1)
   or new.transfer_id is not null or coalesce(new.operation_type,'STANDARD') not in ('STANDARD','EXPENSE')
   or new.category in ('Конвертация валюты','Внутренние перемещения между кассами','CURRENCY_CONVERSION','INTERNAL_TRANSFER')
   or (new.conversion_id is not null and new.conversion_expense_id is null) then
   raise exception 'Связать с расчётами можно только расходный РКО с даты начала учёта';
  end if;
  if exists(select 1 from public.construction_documents where expense_id=new.id and status<>'CANCELLED') then
   raise exception 'РКО уже связан с документом строительного учёта. Повторная оплата запрещена';
  end if;
 end if;
 return new;
end $function$;
ALTER FUNCTION "public"."construction_validate_expense_settlement"() SECURITY INVOKER;
ALTER FUNCTION "public"."construction_validate_expense_settlement"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."construction_validate_expense_settlement"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."construction_validate_expense_settlement"() TO service_role;
CREATE OR REPLACE FUNCTION public.correct_installment_term_atomic(p_deal_id bigint, p_user_id bigint, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 d public.deals%ROWTYPE; old_deal jsonb; old_plan jsonb; result jsonb;
 interval_months integer; first_date date;
 months integer; plan bigint; paid bigint; pool bigint; amount bigint; allocated bigint;
 i integer; due text; sid bigint; base_date date;
 today text := to_char(now() AT TIME ZONE 'Asia/Dushanbe','YYYY-MM-DD');
 stamp text := clock_timestamp()::text;
 metadata jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_user_id AND role='ADMIN' AND is_active=1) THEN
   RAISE EXCEPTION 'Изменение срока доступно только администратору';
 END IF;
 IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR EXISTS (
 SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN
 ('first_payment_date','installment_interval_months','installment_months','expected_updated_at','contract_number','deal_date','lead_name','lead_phone',
 'base_price_minor','discount_minor','final_price_minor','deal_price_per_m2_minor','down_payment_minor','exchange_rate','payment_type','passport_series','passport_number','inn','responsible_user_id','reservation_expires_at','barter_description')) THEN
 RAISE EXCEPTION 'Стоимость и первый взнос нельзя изменять вместе со сроком оплаченной сделки';
 END IF;
 months := (p_changes->>'installment_months')::integer;
 IF months IS NULL OR months<1 OR months>60 THEN RAISE EXCEPTION 'Укажите срок рассрочки от 1 до 60 месяцев'; END IF;
 SELECT * INTO d FROM public.deals WHERE id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Сделка не найдена'; END IF;
 IF d.status NOT IN ('SIGNED','RESERVED') OR d.payment_type<>'INSTALLMENT' THEN
 RAISE EXCEPTION 'Изменение срока доступно только для действующей рассрочки'; END IF;
 IF p_changes->>'expected_updated_at' IS NULL OR
 d.updated_at::timestamptz IS DISTINCT FROM (p_changes->>'expected_updated_at')::timestamptz THEN
 RAISE EXCEPTION 'STALE_DEAL'; END IF;
 -- A term correction must retain the original start date.
 IF p_changes ? 'deal_date' AND p_changes->>'deal_date' IS DISTINCT FROM d.deal_date THEN
 RAISE EXCEPTION 'Сначала сохраните дату договора отдельно от изменения срока'; END IF;
 interval_months := coalesce((p_changes->>'installment_interval_months')::integer,d.installment_interval_months,1);
 IF interval_months<1 OR interval_months>12 THEN RAISE EXCEPTION 'Интервал должен быть от 1 до 12 месяцев'; END IF;
 first_date := coalesce(nullif(p_changes->>'first_payment_date',''),nullif(d.first_payment_date,''),(SELECT min(due_date) FROM public.deal_payment_schedules WHERE deal_id=d.id),(d.deal_date::date+interval '1 month')::date::text)::date;
 IF first_date IS NULL OR first_date<d.deal_date::date THEN RAISE EXCEPTION 'Дата первого платежа должна быть не раньше даты договора'; END IF;
 old_deal := to_jsonb(d);
 IF EXISTS (SELECT 1 FROM public.payments WHERE deal_id=d.id) AND EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k IN ('base_price_minor','discount_minor','final_price_minor','deal_price_per_m2_minor','down_payment_minor','exchange_rate','payment_type')) THEN RAISE EXCEPTION 'Стоимость оплаченной сделки защищена'; END IF;
 PERFORM id FROM public.payments WHERE deal_id=d.id ORDER BY id FOR UPDATE;
 PERFORM id FROM public.deal_payment_schedules WHERE deal_id=d.id ORDER BY id FOR UPDATE;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.payment_number,x.id),'[]'::jsonb)
 INTO old_plan FROM public.deal_payment_schedules x WHERE x.deal_id=d.id;
 IF EXISTS (SELECT 1 FROM public.deal_payment_schedules WHERE deal_id=d.id GROUP BY payment_number HAVING count(*)>1)
 OR EXISTS (SELECT 1 FROM public.deal_payment_schedules WHERE deal_id=d.id AND (payment_number IS NULL OR payment_number<1)) THEN
 RAISE EXCEPTION 'Некорректная нумерация графика. Требуется проверка'; END IF;
 plan := coalesce((p_changes->>'final_price_minor')::bigint,d.final_price_minor)-coalesce((p_changes->>'down_payment_minor')::bigint,d.down_payment_minor);
 IF plan<months THEN RAISE EXCEPTION 'Сумма рассрочки слишком мала для указанного срока'; END IF;
 base_date := coalesce(nullif(d.deal_date,''),substring(d.created_at from 1 for 10))::date;
 IF base_date IS NULL THEN RAISE EXCEPTION 'Укажите дату договора'; END IF;
 SELECT coalesce(sum(amount_minor),0) INTO paid FROM public.payments
 WHERE deal_id=d.id AND status IN ('ACTIVE','POSTED');
 pool := greatest(0,paid-d.down_payment_minor);
 -- Retain existing IDs and receipt references; append only missing periods.
 FOR i IN 1..months LOOP
   due := to_char(first_date+make_interval(months=>(i-1)*interval_months),'YYYY-MM-DD');
   amount := plan/months + CASE WHEN i<=plan%months THEN 1 ELSE 0 END;
   allocated := least(amount,pool); pool:=pool-allocated;
   SELECT id INTO sid FROM public.deal_payment_schedules WHERE deal_id=d.id AND payment_number=i;
   IF sid IS NULL THEN
    INSERT INTO public.deal_payment_schedules(deal_id,payment_number,due_date,amount_minor,paid_amount_minor,status,created_at,updated_at)
    VALUES(d.id,i,due,amount,allocated,CASE WHEN allocated>=amount THEN 'PAID' WHEN allocated>0 THEN 'PARTIAL' WHEN due<today THEN 'OVERDUE' ELSE 'UPCOMING' END,stamp,stamp);
   ELSE
    UPDATE public.deal_payment_schedules SET due_date=due,amount_minor=amount,paid_amount_minor=allocated,
    status=CASE WHEN allocated>=amount THEN 'PAID' WHEN allocated>0 THEN 'PARTIAL' WHEN due<today THEN 'OVERDUE' ELSE 'UPCOMING' END,updated_at=stamp WHERE id=sid;
   END IF;
 END LOOP;
 DELETE FROM public.deal_payment_schedules WHERE deal_id=d.id AND payment_number>months;
 UPDATE public.deals SET installment_months=months,first_payment_date=first_date::text,installment_interval_months=interval_months,updated_at=stamp WHERE id=d.id;
 metadata := p_changes - ARRAY['first_payment_date','installment_interval_months','installment_months','expected_updated_at','lead_name','lead_phone','passport_series','passport_number','inn'];
 -- Existing metadata operation participates in this same transaction.
 PERFORM public.update_deal_atomic(d.id,p_user_id,metadata,
 jsonb_strip_nulls(jsonb_build_object('full_name',nullif(p_changes->>'lead_name',''),
 'phone',nullif(p_changes->>'lead_phone',''),'passport_series',p_changes->>'passport_series',
 'passport_number',p_changes->>'passport_number','inn',p_changes->>'inn')),NULL);
 SELECT to_jsonb(x) INTO result FROM public.deals x WHERE x.id=d.id;
 INSERT INTO public.deal_audit_logs(deal_id,user_id,action,changes_json)
 VALUES(d.id,p_user_id,'CORRECT_INSTALLMENT_TERM',jsonb_build_object('old',old_deal,'new',result,
 'old_schedules',old_plan,'new_schedules',(SELECT jsonb_agg(to_jsonb(x) ORDER BY payment_number) FROM public.deal_payment_schedules x WHERE x.deal_id=d.id),'paid_minor',paid));
 RETURN result;
END;
$function$;
ALTER FUNCTION "public"."correct_installment_term_atomic"(p_deal_id bigint, p_user_id bigint, p_changes jsonb) SECURITY INVOKER;
ALTER FUNCTION "public"."correct_installment_term_atomic"(p_deal_id bigint, p_user_id bigint, p_changes jsonb) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."correct_installment_term_atomic"(p_deal_id bigint, p_user_id bigint, p_changes jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."correct_installment_term_atomic"(p_deal_id bigint, p_user_id bigint, p_changes jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.cost_remove_material_payment(p_id uuid, p_expected integer, p_reason text, p_actor integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old_row public.cost_material_payment_links;
begin
 perform public.cost_require_writer(p_actor); perform pg_catalog.pg_advisory_xact_lock(6101803,1);
 select * into old_row from public.cost_material_payment_links where id=p_id for update;
 if not found or old_row.status<>'ACTIVE' or old_row.version<>p_expected or p_expected is null then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 if p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'Укажите основание отмены'; end if;
 update public.cost_material_payment_links set status='CANCELLED',version=version+1,updated_by=p_actor,updated_at=now() where id=p_id;
 insert into public.cost_material_audit(entity,entity_id,before_data,after_data,actor_id)
 values('PAYMENT',p_id,to_jsonb(old_row),jsonb_build_object('removed',true,'reason',trim(p_reason)),p_actor);
end $function$;
ALTER FUNCTION "public"."cost_remove_material_payment"(p_id uuid, p_expected integer, p_reason text, p_actor integer) SECURITY INVOKER;
ALTER FUNCTION "public"."cost_remove_material_payment"(p_id uuid, p_expected integer, p_reason text, p_actor integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."cost_remove_material_payment"(p_id uuid, p_expected integer, p_reason text, p_actor integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."cost_remove_material_payment"(p_id uuid, p_expected integer, p_reason text, p_actor integer) TO service_role;
CREATE OR REPLACE FUNCTION public.cost_require_writer(p_actor integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from public.users where id=p_actor and is_active::text in ('true','1') and
   (role='ADMIN' or permissions ? '*' or (permissions ? 'finance.costs' and permissions ? 'finance.costs.write')))
 then raise exception 'COST_ACCESS_DENIED'; end if;
end $function$;
ALTER FUNCTION "public"."cost_require_writer"(p_actor integer) SECURITY INVOKER;
ALTER FUNCTION "public"."cost_require_writer"(p_actor integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."cost_require_writer"(p_actor integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."cost_require_writer"(p_actor integer) TO service_role;
CREATE OR REPLACE FUNCTION public.cost_save_allocation(p_expense integer, p_mode text, p_buildings integer[], p_reason text, p_expected integer, p_actor integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old_row public.cost_expense_allocations; new_row public.cost_expense_allocations; e public.expenses;
 shares_data jsonb='[]'; n integer; project_count integer;
begin
 perform public.cost_require_writer(p_actor);
 perform pg_catalog.pg_advisory_xact_lock(6101802,p_expense);
 select * into e from public.expenses where id=p_expense for share;
 if not found then raise exception 'РКО не найден'; end if;
 if p_mode is null or p_mode not in ('DIRECT','SHARED','EXCLUDED','UNASSIGNED') or p_reason is null
 or length(trim(p_reason)) not between 3 and 2000 or p_expected is null or p_buildings is null
 then raise exception 'Некорректное распределение'; end if;
 if p_mode in ('DIRECT','SHARED') then
  if e.voided_at is not null or coalesce(e.status,'ACTIVE') in ('VOIDED','CANCELLED','REVERSED') or e.transfer_id is not null
   or coalesce(e.operation_type,'') like '%TRANSFER%' or e.operation_type='CONVERSION'
   or e.category in ('Внутренние перемещения между кассами','INTERNAL_TRANSFER','Конвертация валюты','CURRENCY_CONVERSION')
   or (e.conversion_id is not null and e.conversion_expense_id is null)
   or exists(select 1 from public.construction_documents where expense_id=p_expense and kind='ADVANCE_ISSUE' and status='POSTED')
  then raise exception 'Перемещение, обмен, подотчёт или аннулированный РКО не включаются в затраты'; end if;
  n=cardinality(p_buildings);
  if n is null or n>100 or (p_mode='DIRECT' and n<>1) or (p_mode='SHARED' and n<2)
   or n<>(select count(distinct x) from unnest(p_buildings) x)
  then raise exception 'Выберите блоки без повторений'; end if;
  if n<>(select count(*) from public.buildings where id=any(p_buildings) and archived_at is null)
  then raise exception 'Блок не найден или архивирован'; end if;
  select count(distinct project_id) into project_count from public.buildings where id=any(p_buildings);
  if project_count<>1 then raise exception 'Общие расходы распределяются внутри одного проекта'; end if;
  if p_mode='DIRECT' then shares_data=jsonb_build_array(jsonb_build_object('building_id',p_buildings[1],'weight',1));
  else
   -- Snapshot confirmed areas. Later basis changes do not silently reallocate old RKO.
   perform 1 from public.cost_building_bases where building_id=any(p_buildings) order by building_id for share;
   if n<>(select count(*) from public.cost_building_bases where building_id=any(p_buildings))
   then raise exception 'Сначала подтвердите продаваемую площадь всех выбранных блоков'; end if;
   select jsonb_agg(jsonb_build_object('building_id',building_id,'weight',sellable_area_m2,'basis_version',version) order by building_id)
   into shares_data from public.cost_building_bases where building_id=any(p_buildings);
  end if;
 elsif cardinality(p_buildings)<>0 then raise exception 'Для исключённого/нераспределённого РКО блоки не указываются';
 end if;
 select * into old_row from public.cost_expense_allocations where expense_id=p_expense for update;
 if coalesce(old_row.version,0)<>p_expected then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 insert into public.cost_expense_allocations(expense_id,mode,shares,reason,updated_by)
 values(p_expense,p_mode,shares_data,trim(p_reason),p_actor)
 on conflict(expense_id) do update set mode=excluded.mode,shares=excluded.shares,reason=excluded.reason,
 updated_by=p_actor,updated_at=now(),version=cost_expense_allocations.version+1 returning * into new_row;
 insert into public.cost_audit(entity,entity_id,before_data,after_data,actor_id)
 values('ALLOCATION',p_expense,case when old_row.expense_id is null then null else to_jsonb(old_row) end,to_jsonb(new_row),p_actor);
 return to_jsonb(new_row);
end $function$;
ALTER FUNCTION "public"."cost_save_allocation"(p_expense integer, p_mode text, p_buildings integer[], p_reason text, p_expected integer, p_actor integer) SECURITY INVOKER;
ALTER FUNCTION "public"."cost_save_allocation"(p_expense integer, p_mode text, p_buildings integer[], p_reason text, p_expected integer, p_actor integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."cost_save_allocation"(p_expense integer, p_mode text, p_buildings integer[], p_reason text, p_expected integer, p_actor integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."cost_save_allocation"(p_expense integer, p_mode text, p_buildings integer[], p_reason text, p_expected integer, p_actor integer) TO service_role;
CREATE OR REPLACE FUNCTION public.cost_save_basis(p_building integer, p_area numeric, p_reason text, p_expected integer, p_actor integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old_row public.cost_building_bases; new_row public.cost_building_bases;
begin
 perform public.cost_require_writer(p_actor);
 perform pg_catalog.pg_advisory_xact_lock(6101801,p_building);
 if not exists(select 1 from public.buildings where id=p_building and archived_at is null)
 then raise exception 'Блок не найден или архивирован'; end if;
 if p_area is null or p_area<=0 or p_area>10000000 or p_area<>round(p_area,2)
    or p_reason is null or length(trim(p_reason)) not between 3 and 2000 or p_expected is null
 then raise exception 'Укажите продаваемую площадь и основание'; end if;
 select * into old_row from public.cost_building_bases where building_id=p_building for update;
 if coalesce(old_row.version,0)<>p_expected then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 insert into public.cost_building_bases(building_id,sellable_area_m2,reason,updated_by)
 values(p_building,p_area,trim(p_reason),p_actor)
 on conflict(building_id) do update set sellable_area_m2=excluded.sellable_area_m2,reason=excluded.reason,
 updated_by=p_actor,updated_at=now(),version=cost_building_bases.version+1 returning * into new_row;
 insert into public.cost_audit(entity,entity_id,before_data,after_data,actor_id)
 values('BASIS',p_building,case when old_row.building_id is null then null else to_jsonb(old_row) end,to_jsonb(new_row),p_actor);
 return to_jsonb(new_row);
end $function$;
ALTER FUNCTION "public"."cost_save_basis"(p_building integer, p_area numeric, p_reason text, p_expected integer, p_actor integer) SECURITY INVOKER;
ALTER FUNCTION "public"."cost_save_basis"(p_building integer, p_area numeric, p_reason text, p_expected integer, p_actor integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."cost_save_basis"(p_building integer, p_area numeric, p_reason text, p_expected integer, p_actor integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."cost_save_basis"(p_building integer, p_area numeric, p_reason text, p_expected integer, p_actor integer) TO service_role;
CREATE OR REPLACE FUNCTION public.cost_save_material_payment(p_id uuid, p_usage uuid, p_expense integer, p_paid numeric, p_cash bigint, p_reason text, p_expected integer, p_actor integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old_row public.cost_material_payment_links; new_row public.cost_material_payment_links; u public.cost_material_usages;
 e public.expenses; available_cash bigint; used_cash bigint; used_paid numeric;
begin
 perform public.cost_require_writer(p_actor);
 perform pg_catalog.pg_advisory_xact_lock(6101803,1);
 select * into old_row from public.cost_material_payment_links where id=p_id for update;
 if coalesce(old_row.version,0)<>p_expected or p_expected is null then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 if old_row.id is not null and (old_row.status<>'ACTIVE' or old_row.usage_id<>p_usage or old_row.expense_id<>p_expense) then raise exception 'Для замены источника отмените привязку'; end if;
 select * into u from public.cost_material_usages where id=p_usage for share;
 if not found or u.status<>'ACTIVE' then raise exception 'Расход материала не найден или отменён'; end if;
 select * into e from public.expenses where id=p_expense for share;
 if not found or e.voided_at is not null or coalesce(e.status,'ACTIVE')<>'ACTIVE' or e.transfer_id is not null
 or coalesce(e.operation_type,'') like '%TRANSFER%' or e.operation_type='CONVERSION'
 or e.category in ('Внутренние перемещения между кассами','INTERNAL_TRANSFER','Конвертация валюты','CURRENCY_CONVERSION')
 or (e.conversion_id is not null and e.conversion_expense_id is null)
 or exists(select 1 from public.construction_documents where expense_id=p_expense and kind='ADVANCE_ISSUE' and status='POSTED')
 then raise exception 'Выберите действующий РКО оплаты поставщику'; end if;
 if p_paid is null or p_paid<=0 or p_paid<>round(p_paid,2) or p_cash is null or p_cash<=0
 or p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'Укажите сумму погашения, часть РКО и основание'; end if;
 available_cash=case when e.currency='USD' then e.amount_minor when e.currency='TJS' and e.exchange_rate>0 then round(e.amount_minor/e.exchange_rate)
 when e.currency='TJS' and e.amount_usd>0 then round(e.amount_usd*100) else null end;
 if available_cash is null or available_cash<=0 then raise exception 'У РКО нет исторического курса или USD-оценки'; end if;
 select coalesce(sum(cash_usd_minor),0) into used_cash from public.cost_material_payment_links where expense_id=p_expense and id<>p_id and status='ACTIVE';
 select coalesce(sum(paid_amount),0) into used_paid from public.cost_material_payment_links where usage_id=p_usage and id<>p_id and status='ACTIVE';
 if used_cash+p_cash>available_cash then raise exception 'Привязки превышают сумму РКО'; end if;
 if used_paid+p_paid>u.amount then raise exception 'Погашение превышает стоимость использованного материала'; end if;
 insert into public.cost_material_payment_links(id,usage_id,expense_id,paid_amount,cash_usd_minor,reason,updated_by)
 values(p_id,p_usage,p_expense,p_paid,p_cash,trim(p_reason),p_actor)
 on conflict(id) do update set paid_amount=excluded.paid_amount,cash_usd_minor=excluded.cash_usd_minor,reason=excluded.reason,
 updated_by=p_actor,updated_at=now(),version=cost_material_payment_links.version+1 returning * into new_row;
 insert into public.cost_material_audit(entity,entity_id,before_data,after_data,actor_id)
 values('PAYMENT',p_id,case when old_row.id is null then null else to_jsonb(old_row) end,to_jsonb(new_row),p_actor);
 return to_jsonb(new_row);
end $function$;
ALTER FUNCTION "public"."cost_save_material_payment"(p_id uuid, p_usage uuid, p_expense integer, p_paid numeric, p_cash bigint, p_reason text, p_expected integer, p_actor integer) SECURITY INVOKER;
ALTER FUNCTION "public"."cost_save_material_payment"(p_id uuid, p_usage uuid, p_expense integer, p_paid numeric, p_cash bigint, p_reason text, p_expected integer, p_actor integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."cost_save_material_payment"(p_id uuid, p_usage uuid, p_expense integer, p_paid numeric, p_cash bigint, p_reason text, p_expected integer, p_actor integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."cost_save_material_payment"(p_id uuid, p_usage uuid, p_expense integer, p_paid numeric, p_cash bigint, p_reason text, p_expected integer, p_actor integer) TO service_role;
CREATE OR REPLACE FUNCTION public.cost_save_material_usage(p_id uuid, p_data jsonb, p_expected integer, p_actor integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old_row public.cost_material_usages; new_row public.cost_material_usages;
 stock public.construction_stock_entries; doc public.construction_documents;
 b integer; source_id bigint; qty numeric; val numeric; fx numeric; cur text; dt date; un text; st text;
begin
 perform public.cost_require_writer(p_actor);
 -- One lock for material mutations: prevents link/save/remove races.
 perform pg_catalog.pg_advisory_xact_lock(6101803,1);
 select * into old_row from public.cost_material_usages where id=p_id for update;
 if coalesce(old_row.version,0)<>p_expected or p_expected is null then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 b=(p_data->>'building_id')::integer; source_id=(p_data->>'stock_entry_id')::bigint;
 st=coalesce(p_data->>'status','ACTIVE');
 if st not in ('ACTIVE','CANCELLED') or p_data->>'material_kind' is null or p_data->>'material_kind' not in ('REBAR','CONCRETE')
 or p_data->>'reason' is null or length(trim(p_data->>'reason')) not between 3 and 2000
 then raise exception 'Укажите вид материала и основание'; end if;
 if exists(select 1 from public.cost_material_payment_links where usage_id=p_id and status='ACTIVE')
 then raise exception 'Сначала отмените привязки оплат, затем изменяйте расход материала'; end if;
 if not exists(select 1 from public.buildings where id=b and archived_at is null) then raise exception 'Блок не найден или архивирован'; end if;
 if source_id is not null then
  select * into stock from public.construction_stock_entries where id=source_id;
  if not found or stock.quantity>=0 or stock.value>=0 then raise exception 'Выберите списание материала'; end if;
  select * into doc from public.construction_documents where id=stock.document_id;
  if doc.status<>'POSTED' or doc.kind not in ('ISSUE','WRITE_OFF') then raise exception 'Источник не проведён'; end if;
  if doc.project_id is not null and doc.project_id<>(select project_id from public.buildings where id=b) then raise exception 'Источник относится к другому проекту'; end if;
  qty=-stock.quantity; val=-stock.value; cur=stock.currency; dt=doc.doc_date;
  select unit into un from public.construction_materials where id=stock.material_id;
  fx=coalesce(doc.exchange_rate,(p_data->>'exchange_rate')::numeric);
 else
  qty=(p_data->>'quantity')::numeric; val=(p_data->>'amount')::numeric;
  cur=p_data->>'currency'; dt=(p_data->>'usage_date')::date;
  fx=(p_data->>'exchange_rate')::numeric; un=trim(p_data->>'unit');
 end if;
 if qty is null or qty<=0 or qty>1000000000 or qty<>round(qty,4) or val is null or val<=0 or val>1000000000000 or val<>round(val,2)
 or dt is null or dt<'2000-01-01' or cur is null or cur not in ('USD','TJS') or un is null or length(un) not between 1 and 30
 or (cur='TJS' and (fx is null or fx<=0)) then raise exception 'Проверьте количество, стоимость, дату и исторический курс'; end if;
 insert into public.cost_material_usages(id,stock_entry_id,building_id,material_kind,usage_date,quantity,unit,amount,currency,exchange_rate,reason,status,updated_by)
 values(p_id,source_id,b,p_data->>'material_kind',dt,qty,un,val,cur,fx,trim(p_data->>'reason'),st,p_actor)
 on conflict(id) do update set stock_entry_id=excluded.stock_entry_id,building_id=excluded.building_id,material_kind=excluded.material_kind,
 usage_date=excluded.usage_date,quantity=excluded.quantity,unit=excluded.unit,amount=excluded.amount,currency=excluded.currency,
 exchange_rate=excluded.exchange_rate,reason=excluded.reason,status=excluded.status,updated_by=p_actor,updated_at=now(),version=cost_material_usages.version+1
 returning * into new_row;
 insert into public.cost_material_audit(entity,entity_id,before_data,after_data,actor_id)
 values('USAGE',p_id,case when old_row.id is null then null else to_jsonb(old_row) end,to_jsonb(new_row),p_actor);
 return to_jsonb(new_row);
end $function$;
ALTER FUNCTION "public"."cost_save_material_usage"(p_id uuid, p_data jsonb, p_expected integer, p_actor integer) SECURITY INVOKER;
ALTER FUNCTION "public"."cost_save_material_usage"(p_id uuid, p_data jsonb, p_expected integer, p_actor integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."cost_save_material_usage"(p_id uuid, p_data jsonb, p_expected integer, p_actor integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."cost_save_material_usage"(p_id uuid, p_data jsonb, p_expected integer, p_actor integer) TO service_role;
CREATE OR REPLACE FUNCTION public.create_atomic_cash_transfer(p_source_cash_desk_id uuid, p_destination_cash_desk_id uuid, p_operation_type character varying, p_currency character varying, p_amount_tjs numeric, p_exchange_rate numeric, p_amount_usd numeric, p_transfer_date date, p_recipient character varying, p_description text, p_idempotency_key character varying, p_user_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_source_desk RECORD;
  v_dest_desk RECORD;
  v_final_amount_usd NUMERIC(14,2);
  v_final_amount_tjs NUMERIC(14,2);
  v_final_exchange_rate NUMERIC(12,6);
  v_amount_minor BIGINT;
  v_available_balance NUMERIC(14,2);
  v_source_income NUMERIC(14,2);
  v_source_expense NUMERIC(14,2);
  v_transfer_id UUID;
  v_expense_id INT;
  v_payment_id INT;
  v_next_rko_num INT;
  v_next_pko_num INT;
  v_rko_ref VARCHAR(64);
  v_pko_ref VARCHAR(64);
  v_existing_transfer RECORD;
BEGIN
  -- 1. Check idempotency
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    SELECT * INTO v_existing_transfer FROM cash_transfers WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'transfer_id', v_existing_transfer.id,
        'source_expense_id', v_existing_transfer.source_expense_id,
        'destination_payment_id', v_existing_transfer.destination_payment_id,
        'amount_usd', v_existing_transfer.amount_usd,
        'amount_tjs', v_existing_transfer.amount_tjs,
        'exchange_rate', v_existing_transfer.exchange_rate,
        'status', v_existing_transfer.status
      );
    END IF;
  END IF;

  -- 2. Check cash desks
  IF p_source_cash_desk_id = p_destination_cash_desk_id THEN
    RAISE EXCEPTION 'SOURCE_AND_DESTINATION_MUST_BE_DIFFERENT';
  END IF;

  SELECT * INTO v_source_desk FROM dictionaries WHERE id = p_source_cash_desk_id AND type = 'CASH_DESK';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOURCE_CASH_DESK_NOT_FOUND';
  END IF;

  SELECT * INTO v_dest_desk FROM dictionaries WHERE id = p_destination_cash_desk_id AND type = 'CASH_DESK';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DESTINATION_CASH_DESK_NOT_FOUND';
  END IF;

  -- 3. Calculate and validate snapshot amounts and rates
  IF p_currency = 'TJS' THEN
    IF p_amount_tjs IS NULL OR p_amount_tjs <= 0 THEN
      RAISE EXCEPTION 'INVALID_TJS_AMOUNT';
    END IF;
    v_final_amount_tjs := ROUND(p_amount_tjs, 2);

    IF p_exchange_rate IS NOT NULL AND p_exchange_rate > 0 THEN
      v_final_exchange_rate := p_exchange_rate;
      v_final_amount_usd := ROUND(v_final_amount_tjs / v_final_exchange_rate, 2);
    ELSIF p_amount_usd IS NOT NULL AND p_amount_usd > 0 THEN
      v_final_amount_usd := ROUND(p_amount_usd, 2);
      v_final_exchange_rate := ROUND(v_final_amount_tjs / v_final_amount_usd, 6);
    ELSE
      v_final_amount_usd := NULL;
      v_final_exchange_rate := NULL;
    END IF;
  ELSE
    IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
      RAISE EXCEPTION 'INVALID_USD_AMOUNT';
    END IF;
    v_final_amount_usd := ROUND(p_amount_usd, 2);

    IF p_amount_tjs IS NOT NULL AND p_amount_tjs > 0 AND p_exchange_rate IS NOT NULL AND p_exchange_rate > 0 THEN
      v_final_amount_tjs := ROUND(p_amount_tjs, 2);
      v_final_exchange_rate := p_exchange_rate;
    ELSIF p_amount_tjs IS NOT NULL AND p_amount_tjs > 0 THEN
      v_final_amount_tjs := ROUND(p_amount_tjs, 2);
      v_final_exchange_rate := ROUND(v_final_amount_tjs / v_final_amount_usd, 6);
    ELSIF p_exchange_rate IS NOT NULL AND p_exchange_rate > 0 THEN
      v_final_exchange_rate := p_exchange_rate;
      v_final_amount_tjs := ROUND(v_final_amount_usd * v_final_exchange_rate, 2);
    ELSE
      v_final_amount_tjs := NULL;
      v_final_exchange_rate := NULL;
    END IF;
  END IF;

  v_amount_minor := (v_final_amount_usd * 100)::BIGINT;

  -- 4. Check available balance of source cash desk (in USD)
  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_source_income
  FROM payments
  WHERE (cash_desk_id = p_source_cash_desk_id OR (cash_desk_id IS NULL AND comment ILIKE '%' || v_source_desk.name || '%'))
    AND status = 'ACTIVE'
    AND currency = 'USD';

  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_source_expense
  FROM expenses
  WHERE (cash_desk_id = p_source_cash_desk_id OR (cash_desk_id IS NULL AND description ILIKE '%' || v_source_desk.name || '%'))
    AND status = 'ACTIVE'
    AND currency = 'USD';

  v_available_balance := v_source_income - v_source_expense;

  IF v_available_balance < v_final_amount_usd THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: Available USD % is less than requested USD %', v_available_balance, v_final_amount_usd;
  END IF;

  -- 5. Generate transfer_id and references
  v_transfer_id := gen_random_uuid();
  v_next_rko_num := COALESCE((SELECT MAX(id) FROM expenses), 0) + 1;
  v_next_pko_num := COALESCE((SELECT MAX(id) FROM payments), 0) + 1;
  v_rko_ref := 'РКО-ПЕРЕМ-' || v_next_rko_num;
  v_pko_ref := 'ПКО-ПЕРЕМ-' || v_next_pko_num;

  -- 6. Insert source RKO
  INSERT INTO expenses (
    amount_minor, expense_date, category, description, created_by_user_id, created_at,
    currency, method, reference, recipient, exchange_rate, amount_usd, amount_tjs,
    cash_desk_id, transfer_id, status, operation_type
  ) VALUES (
    v_amount_minor, p_transfer_date, 'Внутренние перемещения между кассами',
    '[Касса: ' || v_source_desk.name || '] Внутреннее перемещение: ' || COALESCE(p_description, 'Перемещение средств') || ' • в кассу: ' || v_dest_desk.name,
    p_user_id, NOW(), 'USD', 'CASH', v_rko_ref, v_dest_desk.name,
    v_final_exchange_rate, v_final_amount_usd, v_final_amount_tjs,
    p_source_cash_desk_id, v_transfer_id, 'ACTIVE', COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER')
  ) RETURNING id INTO v_expense_id;

  -- 7. Insert destination PKO
  INSERT INTO payments (
    deal_id, schedule_id, amount_minor, payment_date, method, reference, comment,
    created_by_user_id, created_at, currency, payer_name, cash_desk_id, transfer_id,
    status, operation_type, amount_tjs, amount_usd, exchange_rate
  ) VALUES (
    NULL, NULL, v_amount_minor, p_transfer_date::TEXT, 'CASH', v_pko_ref,
    '[Касса: ' || v_dest_desk.name || '] Внутреннее перемещение: ' || COALESCE(p_description, 'Поступление средств') || ' • из кассы: ' || v_source_desk.name,
    p_user_id, NOW(), 'USD', v_source_desk.name, p_destination_cash_desk_id, v_transfer_id,
    'ACTIVE', COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER'),
    v_final_amount_tjs, v_final_amount_usd, v_final_exchange_rate
  ) RETURNING id INTO v_payment_id;

  -- 8. Insert master cash_transfers record
  INSERT INTO cash_transfers (
    id, operation_type, source_cash_desk_id, destination_cash_desk_id,
    source_expense_id, destination_payment_id, currency, amount_minor,
    amount_tjs, amount_usd, exchange_rate, recipient, description,
    status, idempotency_key, created_by, created_at
  ) VALUES (
    v_transfer_id, COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER'),
    p_source_cash_desk_id, p_destination_cash_desk_id,
    v_expense_id, v_payment_id, p_currency, v_amount_minor,
    v_final_amount_tjs, v_final_amount_usd, v_final_exchange_rate,
    p_recipient, p_description, 'ACTIVE', p_idempotency_key, p_user_id, NOW()
  );

  -- 9. Return JSON response
  RETURN jsonb_build_object(
    'success', true,
    'transfer_id', v_transfer_id,
    'source_expense_id', v_expense_id,
    'destination_payment_id', v_payment_id,
    'source_reference', v_rko_ref,
    'destination_reference', v_pko_ref,
    'amount_usd', v_final_amount_usd,
    'amount_tjs', v_final_amount_tjs,
    'exchange_rate', v_final_exchange_rate,
    'status', 'ACTIVE'
  );
END;
$function$;
ALTER FUNCTION "public"."create_atomic_cash_transfer"(p_source_cash_desk_id uuid, p_destination_cash_desk_id uuid, p_operation_type character varying, p_currency character varying, p_amount_tjs numeric, p_exchange_rate numeric, p_amount_usd numeric, p_transfer_date date, p_recipient character varying, p_description text, p_idempotency_key character varying, p_user_id integer) SECURITY INVOKER;
ALTER FUNCTION "public"."create_atomic_cash_transfer"(p_source_cash_desk_id uuid, p_destination_cash_desk_id uuid, p_operation_type character varying, p_currency character varying, p_amount_tjs numeric, p_exchange_rate numeric, p_amount_usd numeric, p_transfer_date date, p_recipient character varying, p_description text, p_idempotency_key character varying, p_user_id integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."create_atomic_cash_transfer"(p_source_cash_desk_id uuid, p_destination_cash_desk_id uuid, p_operation_type character varying, p_currency character varying, p_amount_tjs numeric, p_exchange_rate numeric, p_amount_usd numeric, p_transfer_date date, p_recipient character varying, p_description text, p_idempotency_key character varying, p_user_id integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."create_atomic_cash_transfer"(p_source_cash_desk_id uuid, p_destination_cash_desk_id uuid, p_operation_type character varying, p_currency character varying, p_amount_tjs numeric, p_exchange_rate numeric, p_amount_usd numeric, p_transfer_date date, p_recipient character varying, p_description text, p_idempotency_key character varying, p_user_id integer) TO service_role;
CREATE OR REPLACE FUNCTION public.create_atomic_expense(p_cash_desk_id uuid, p_amount_minor bigint, p_currency character varying, p_expense_date date, p_category character varying, p_recipient character varying, p_description text, p_user_id integer, p_method character varying DEFAULT 'CASH'::character varying, p_exchange_rate numeric DEFAULT NULL::numeric, p_amount_usd numeric DEFAULT NULL::numeric, p_amount_tjs numeric DEFAULT NULL::numeric, p_idempotency_key character varying DEFAULT NULL::character varying)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_expense RECORD;
  v_desk RECORD;
  v_user RECORD;
  v_current_income NUMERIC(14,2);
  v_current_expense NUMERIC(14,2);
  v_current_balance NUMERIC(14,2);
  v_request_amount NUMERIC(14,2);
  v_expense_id INT;
  v_ref VARCHAR(64);
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Параметр idempotency_key обязателен для создания РКО';
  END IF;

  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Сумма операции должна быть строго больше нуля';
  END IF;

  IF p_currency IS NULL OR p_currency NOT IN ('USD', 'TJS') THEN
    RAISE EXCEPTION 'INVALID_CURRENCY: Разрешены только валюты USD и TJS. Получено: %', p_currency;
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: Пользователь id=% не найден', p_user_id;
  END IF;

  IF p_currency = 'USD' THEN
    IF p_amount_usd IS NOT NULL AND ROUND(p_amount_usd * 100) <> p_amount_minor THEN
      RAISE EXCEPTION 'AMOUNT_MISMATCH: amount_usd (%) не соответствует amount_minor (%)', p_amount_usd, p_amount_minor;
    END IF;
  ELSIF p_currency = 'TJS' THEN
    IF p_amount_tjs IS NOT NULL AND ROUND(p_amount_tjs * 100) <> p_amount_minor THEN
      RAISE EXCEPTION 'AMOUNT_MISMATCH: amount_tjs (%) не соответствует amount_minor (%)', p_amount_tjs, p_amount_minor;
    END IF;
    IF p_exchange_rate IS NOT NULL AND p_exchange_rate <= 0 THEN
      RAISE EXCEPTION 'INVALID_EXCHANGE_RATE: Курс обмена должен быть положительным';
    END IF;
  END IF;

  SELECT * INTO v_existing_expense FROM public.expenses WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'expense_id', v_existing_expense.id,
      'reference', v_existing_expense.reference,
      'cash_desk_id', v_existing_expense.cash_desk_id,
      'amount', (v_existing_expense.amount_minor / 100.0),
      'currency', v_existing_expense.currency,
      'balance_after', NULL
    );
  END IF;

  SELECT * INTO v_desk 
  FROM public.dictionaries 
  WHERE id = p_cash_desk_id AND type = 'CASH_DESK' 
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASH_DESK_NOT_FOUND: Касса с id=% не найдена', p_cash_desk_id;
  END IF;

  SELECT * INTO v_existing_expense FROM public.expenses WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'expense_id', v_existing_expense.id,
      'reference', v_existing_expense.reference,
      'cash_desk_id', v_existing_expense.cash_desk_id,
      'amount', (v_existing_expense.amount_minor / 100.0),
      'currency', v_existing_expense.currency,
      'balance_after', NULL
    );
  END IF;

  v_request_amount := (p_amount_minor / 100.0);

  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_current_income
  FROM public.payments
  WHERE cash_desk_id = p_cash_desk_id
    AND status = 'ACTIVE'
    AND currency = p_currency;

  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_current_expense
  FROM public.expenses
  WHERE cash_desk_id = p_cash_desk_id
    AND status = 'ACTIVE'
    AND currency = p_currency;

  v_current_balance := v_current_income - v_current_expense;

  IF v_current_balance < v_request_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: Недостаточно средств в кассе. Доступно: % %, запрошено: % %', v_current_balance, p_currency, v_request_amount, p_currency;
  END IF;

  BEGIN
    INSERT INTO public.expenses (
      cash_desk_id,
      amount_minor,
      currency,
      expense_date,
      category,
      recipient,
      description,
      created_by_user_id,
      method,
      reference,
      exchange_rate,
      amount_usd,
      amount_tjs,
      status,
      operation_type,
      idempotency_key,
      created_at
    ) VALUES (
      p_cash_desk_id,
      p_amount_minor,
      p_currency,
      p_expense_date,
      COALESCE(p_category, 'Прочее'),
      p_recipient,
      p_description,
      p_user_id,
      COALESCE(p_method, 'CASH'),
      'TEMP_REF',
      p_exchange_rate,
      p_amount_usd,
      p_amount_tjs,
      'ACTIVE',
      'STANDARD',
      p_idempotency_key,
      NOW()
    ) RETURNING id INTO v_expense_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing_expense FROM public.expenses WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'expense_id', v_existing_expense.id,
        'reference', v_existing_expense.reference,
        'cash_desk_id', v_existing_expense.cash_desk_id,
        'amount', (v_existing_expense.amount_minor / 100.0),
        'currency', v_existing_expense.currency,
        'balance_after', NULL
      );
    END IF;
  END;

  v_ref := 'РКО-' || v_expense_id;
  UPDATE public.expenses SET reference = v_ref WHERE id = v_expense_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'expense_id', v_expense_id,
    'reference', v_ref,
    'cash_desk_id', p_cash_desk_id,
    'amount', v_request_amount,
    'currency', p_currency,
    'balance_after', v_current_balance - v_request_amount
  );
END;
$function$;
ALTER FUNCTION "public"."create_atomic_expense"(p_cash_desk_id uuid, p_amount_minor bigint, p_currency character varying, p_expense_date date, p_category character varying, p_recipient character varying, p_description text, p_user_id integer, p_method character varying, p_exchange_rate numeric, p_amount_usd numeric, p_amount_tjs numeric, p_idempotency_key character varying) SECURITY INVOKER;
ALTER FUNCTION "public"."create_atomic_expense"(p_cash_desk_id uuid, p_amount_minor bigint, p_currency character varying, p_expense_date date, p_category character varying, p_recipient character varying, p_description text, p_user_id integer, p_method character varying, p_exchange_rate numeric, p_amount_usd numeric, p_amount_tjs numeric, p_idempotency_key character varying) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."create_atomic_expense"(p_cash_desk_id uuid, p_amount_minor bigint, p_currency character varying, p_expense_date date, p_category character varying, p_recipient character varying, p_description text, p_user_id integer, p_method character varying, p_exchange_rate numeric, p_amount_usd numeric, p_amount_tjs numeric, p_idempotency_key character varying) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."create_atomic_expense"(p_cash_desk_id uuid, p_amount_minor bigint, p_currency character varying, p_expense_date date, p_category character varying, p_recipient character varying, p_description text, p_user_id integer, p_method character varying, p_exchange_rate numeric, p_amount_usd numeric, p_amount_tjs numeric, p_idempotency_key character varying) TO service_role;
CREATE OR REPLACE FUNCTION public.create_atomic_payment(p_deal_id integer, p_schedule_id integer DEFAULT NULL::integer, p_amount_minor integer DEFAULT NULL::integer, p_payment_date date DEFAULT NULL::date, p_method text DEFAULT 'CASH'::text, p_reference text DEFAULT NULL::text, p_comment text DEFAULT NULL::text, p_cash_desk_id uuid DEFAULT NULL::uuid, p_created_by_user_id integer DEFAULT NULL::integer, p_idempotency_key text DEFAULT NULL::text, p_currency text DEFAULT 'USD'::text, p_payer_name text DEFAULT NULL::text, p_amount_tjs numeric DEFAULT NULL::numeric, p_amount_usd numeric DEFAULT NULL::numeric, p_exchange_rate numeric DEFAULT NULL::numeric)
 RETURNS TABLE(payment_id integer, is_duplicate boolean, created_new boolean)
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
DECLARE
  v_existing_id INT;
  v_ex_deal INT;
  v_ex_sched INT;
  v_ex_amount INT;
  v_ex_date DATE;
  v_ex_desk UUID;
  v_ex_user INT;
  v_ex_curr TEXT;
  v_ex_tjs NUMERIC;
  v_ex_usd NUMERIC;
  v_ex_rate NUMERIC;

  v_deal_check INT;
  v_desk_check UUID;
  v_user_check INT;

  v_sched_id INT;
  v_sched_amount INT;
  v_sched_paid INT;

  v_new_paid INT;
  v_new_status TEXT;
  v_new_payment_id INT;
BEGIN
  -- 1. Валидация входных параметров
  IF p_idempotency_key IS NULL OR trim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Ключ идемпотентности обязателен для проведения ПКО';
  END IF;

  IF p_payment_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE: Дата платежа обязательна (p_payment_date IS NOT NULL)';
  END IF;

  IF p_currency IS NULL OR p_currency NOT IN ('USD', 'TJS') THEN
    RAISE EXCEPTION 'INVALID_CURRENCY: Валюта должна быть USD или TJS';
  END IF;

  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Сумма ПКО должна быть больше нуля';
  END IF;

  IF p_exchange_rate IS NOT NULL AND p_exchange_rate <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXCHANGE_RATE: Курс обмена должен быть больше нуля';
  END IF;

  IF (p_amount_tjs IS NOT NULL AND p_amount_tjs < 0) OR (p_amount_usd IS NOT NULL AND p_amount_usd < 0) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT_CURRENCY: Сумма в валюте не может быть отрицательной';
  END IF;

  IF p_amount_tjs IS NOT NULL AND p_amount_usd IS NOT NULL AND p_exchange_rate IS NOT NULL AND p_exchange_rate > 0 THEN
    IF ABS(p_amount_usd * p_exchange_rate - p_amount_tjs) > 0.01 THEN
      RAISE EXCEPTION 'CURRENCY_MISMATCH: Несоответствие сумм TJS, USD и курса обмена (превышена погрешность 0.01)';
    END IF;
  END IF;

  -- 2. Первая проверка идемпотентности по 10 финансово значимым полям до блокировки
  SELECT p.id, p.deal_id, p.schedule_id, p.amount_minor, p.payment_date, p.cash_desk_id, p.created_by_user_id, p.currency, p.amount_tjs, p.amount_usd, p.exchange_rate
  INTO v_existing_id, v_ex_deal, v_ex_sched, v_ex_amount, v_ex_date, v_ex_desk, v_ex_user, v_ex_curr, v_ex_tjs, v_ex_usd, v_ex_rate
  FROM public.payments p
  WHERE p.idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    IF v_ex_deal IS DISTINCT FROM p_deal_id OR
       v_ex_sched IS DISTINCT FROM p_schedule_id OR
       v_ex_amount IS DISTINCT FROM p_amount_minor OR
       v_ex_date IS DISTINCT FROM p_payment_date OR
       v_ex_desk IS DISTINCT FROM p_cash_desk_id OR
       v_ex_user IS DISTINCT FROM p_created_by_user_id OR
       v_ex_curr IS DISTINCT FROM p_currency OR
       v_ex_tjs IS DISTINCT FROM p_amount_tjs OR
       v_ex_usd IS DISTINCT FROM p_amount_usd OR
       v_ex_rate IS DISTINCT FROM p_exchange_rate THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Ключ идемпотентности уже использован с другими параметрами платежа';
    END IF;

    RETURN QUERY SELECT v_existing_id, true, false;
    RETURN;
  END IF;

  -- 3. Проверки существования базовых сущностей
  SELECT id INTO v_deal_check FROM public.deals WHERE id = p_deal_id;
  IF v_deal_check IS NULL THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка #% не найдена', p_deal_id;
  END IF;

  SELECT id INTO v_desk_check FROM public.dictionaries WHERE id = p_cash_desk_id AND type = 'CASH_DESK';
  IF v_desk_check IS NULL THEN
    RAISE EXCEPTION 'CASH_DESK_NOT_FOUND: Выбранная касса не найдена';
  END IF;

  SELECT id INTO v_user_check FROM public.users WHERE id = p_created_by_user_id;
  IF v_user_check IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: Пользователь #% не найден', p_created_by_user_id;
  END IF;

  -- 4. Пессимистическая блокировка строки графика через FOR UPDATE
  IF p_schedule_id IS NOT NULL THEN
    SELECT id, amount_minor, paid_amount_minor
    INTO v_sched_id, v_sched_amount, v_sched_paid
    FROM public.deal_payment_schedules
    WHERE id = p_schedule_id AND deal_id = p_deal_id
    FOR UPDATE;

    IF v_sched_id IS NULL THEN
      RAISE EXCEPTION 'SCHEDULE_NOT_FOUND: График #% не найден для сделки #%', p_schedule_id, p_deal_id;
    END IF;
  END IF;

  -- 5. Повторная проверка идемпотентности ПОСЛЕ блокировки FOR UPDATE по 10 полям
  SELECT p.id, p.deal_id, p.schedule_id, p.amount_minor, p.payment_date, p.cash_desk_id, p.created_by_user_id, p.currency, p.amount_tjs, p.amount_usd, p.exchange_rate
  INTO v_existing_id, v_ex_deal, v_ex_sched, v_ex_amount, v_ex_date, v_ex_desk, v_ex_user, v_ex_curr, v_ex_tjs, v_ex_usd, v_ex_rate
  FROM public.payments p
  WHERE p.idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    IF v_ex_deal IS DISTINCT FROM p_deal_id OR
       v_ex_sched IS DISTINCT FROM p_schedule_id OR
       v_ex_amount IS DISTINCT FROM p_amount_minor OR
       v_ex_date IS DISTINCT FROM p_payment_date OR
       v_ex_desk IS DISTINCT FROM p_cash_desk_id OR
       v_ex_user IS DISTINCT FROM p_created_by_user_id OR
       v_ex_curr IS DISTINCT FROM p_currency OR
       v_ex_tjs IS DISTINCT FROM p_amount_tjs OR
       v_ex_usd IS DISTINCT FROM p_amount_usd OR
       v_ex_rate IS DISTINCT FROM p_exchange_rate THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Ключ идемпотентности уже использован с другими параметрами платежа';
    END IF;

    RETURN QUERY SELECT v_existing_id, true, false;
    RETURN;
  END IF;

  -- 6. Вставка ПКО во вложенном блоке с перехватом unique_violation
  BEGIN
    INSERT INTO public.payments (
      deal_id, schedule_id, amount_minor, payment_date, method, reference, comment,
      cash_desk_id, created_by_user_id, idempotency_key, created_at, status,
      currency, payer_name, amount_tjs, amount_usd, exchange_rate
    ) VALUES (
      p_deal_id, p_schedule_id, p_amount_minor, p_payment_date, COALESCE(p_method, 'CASH'), p_reference, p_comment,
      p_cash_desk_id, p_created_by_user_id, p_idempotency_key, NOW(), 'ACTIVE',
      p_currency, p_payer_name, p_amount_tjs, p_amount_usd, p_exchange_rate
    ) RETURNING id INTO v_new_payment_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT p.id, p.deal_id, p.schedule_id, p.amount_minor, p.payment_date, p.cash_desk_id, p.created_by_user_id, p.currency, p.amount_tjs, p.amount_usd, p.exchange_rate
    INTO v_existing_id, v_ex_deal, v_ex_sched, v_ex_amount, v_ex_date, v_ex_desk, v_ex_user, v_ex_curr, v_ex_tjs, v_ex_usd, v_ex_rate
    FROM public.payments p
    WHERE p.idempotency_key = p_idempotency_key;

    IF v_existing_id IS NOT NULL THEN
      IF v_ex_deal IS DISTINCT FROM p_deal_id OR
         v_ex_sched IS DISTINCT FROM p_schedule_id OR
         v_ex_amount IS DISTINCT FROM p_amount_minor OR
         v_ex_date IS DISTINCT FROM p_payment_date OR
         v_ex_desk IS DISTINCT FROM p_cash_desk_id OR
         v_ex_user IS DISTINCT FROM p_created_by_user_id OR
         v_ex_curr IS DISTINCT FROM p_currency OR
         v_ex_tjs IS DISTINCT FROM p_amount_tjs OR
         v_ex_usd IS DISTINCT FROM p_amount_usd OR
         v_ex_rate IS DISTINCT FROM p_exchange_rate THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Ключ идемпотентности уже использован с другими параметрами платежа';
      END IF;

      RETURN QUERY SELECT v_existing_id, true, false;
      RETURN;
    ELSE
      RAISE;
    END IF;
  END;

  -- 7. Обновление графика платежей только при успешной новой вставке
  IF p_schedule_id IS NOT NULL AND v_sched_id IS NOT NULL THEN
    v_new_paid := COALESCE(v_sched_paid, 0) + p_amount_minor;
    v_new_status := CASE WHEN v_new_paid >= v_sched_amount THEN 'PAID' ELSE 'PARTIAL' END;

    UPDATE public.deal_payment_schedules
    SET paid_amount_minor = v_new_paid,
        status = v_new_status,
        updated_at = NOW()
    WHERE id = p_schedule_id;
  END IF;

  RETURN QUERY SELECT v_new_payment_id, false, true;
END;
$function$;
ALTER FUNCTION "public"."create_atomic_payment"(p_deal_id integer, p_schedule_id integer, p_amount_minor integer, p_payment_date date, p_method text, p_reference text, p_comment text, p_cash_desk_id uuid, p_created_by_user_id integer, p_idempotency_key text, p_currency text, p_payer_name text, p_amount_tjs numeric, p_amount_usd numeric, p_exchange_rate numeric) SECURITY INVOKER;
ALTER FUNCTION "public"."create_atomic_payment"(p_deal_id integer, p_schedule_id integer, p_amount_minor integer, p_payment_date date, p_method text, p_reference text, p_comment text, p_cash_desk_id uuid, p_created_by_user_id integer, p_idempotency_key text, p_currency text, p_payer_name text, p_amount_tjs numeric, p_amount_usd numeric, p_exchange_rate numeric) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."create_atomic_payment"(p_deal_id integer, p_schedule_id integer, p_amount_minor integer, p_payment_date date, p_method text, p_reference text, p_comment text, p_cash_desk_id uuid, p_created_by_user_id integer, p_idempotency_key text, p_currency text, p_payer_name text, p_amount_tjs numeric, p_amount_usd numeric, p_exchange_rate numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."create_atomic_payment"(p_deal_id integer, p_schedule_id integer, p_amount_minor integer, p_payment_date date, p_method text, p_reference text, p_comment text, p_cash_desk_id uuid, p_created_by_user_id integer, p_idempotency_key text, p_currency text, p_payer_name text, p_amount_tjs numeric, p_amount_usd numeric, p_exchange_rate numeric) TO service_role;
CREATE OR REPLACE FUNCTION public.create_expense_with_settlement(p_data jsonb, p_actor integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare e public.expenses; u public.users; r jsonb; fx_out jsonb; fx_in integer;
 key text:=trim(p_data->>'idempotency_key'); party uuid:=(p_data->>'settlement_party_id')::uuid;
 account text:=p_data->>'settlement_account'; cur text:=p_data->>'currency';
 qty numeric:=(p_data->>'amount')::numeric; rate numeric:=(p_data->>'exchange_rate')::numeric;
 desk uuid:=(p_data->>'cash_desk_id')::uuid; dt date:=(p_data->>'expense_date')::date;
 fx_id uuid; source_qty numeric; converted boolean:=false;
begin
 select * into u from public.users where id=p_actor and to_jsonb(users)->>'is_active' in ('true','1');
 if not found then raise exception 'Нет доступа' using errcode='42501'; end if;
 if key is null or length(key) not between 1 and 100 or qty is null or qty<=0 or qty<>round(qty,2) or qty*100>2147483647
  or party is null or account is null or account not in ('PAYABLE','ADVANCE_GIVEN','RECEIVABLE','ADVANCE_RECEIVED')
  or cur is null or cur not in ('TJS','USD') or dt is null or desk is null then raise exception 'Проверьте сумму, кассу, дату и контрагента РКО'; end if;
 if cur='TJS' and (rate is null or rate<=0) then raise exception 'Укажите исторический курс TJS за 1 USD'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('expense-settlement:'||key,0));
 select * into e from public.expenses where idempotency_key=key for update;
 if found then
  if e.created_by_user_id<>p_actor or e.cash_desk_id<>desk or e.amount_minor<>qty*100 or e.currency<>cur
   or e.settlement_party_id is distinct from party or e.settlement_account is distinct from account or e.expense_date<>dt then
   raise exception 'Ключ РКО уже использован для другой операции' using errcode='23505';
  end if;
  return to_jsonb(e)||jsonb_build_object('amount',qty,'idempotent',true);
 end if;
 if coalesce(p_data->>'settlement_method','CASH')<>'CASH' or coalesce((p_data->>'is_transfer')::boolean,false) then raise exception 'Используйте обычный расходный РКО'; end if;
 if cur='TJS' and coalesce((p_data->>'auto_convert')::boolean,false) then
  if coalesce(p_data->>'source_currency','USD')<>'USD' then raise exception 'Автоконвертация поддерживает источник USD'; end if;
  fx_id=gen_random_uuid(); source_qty=round(qty/rate,2);
  if source_qty<=0 then raise exception 'Сумма слишком мала для конвертации'; end if;
  fx_out=public.create_atomic_expense(desk,(source_qty*100)::bigint,'USD',dt,'Конвертация валюты','Касса TJS (Автоконвертация)',
   'Автоконвертация для оплаты контрагенту',p_actor,coalesce(p_data->>'method','CASH'),rate,source_qty,null,key||':FX');
  update public.expenses set conversion_id=fx_id,operation_type='CONVERSION',reference='КОНВ-'||id where id=(fx_out->>'expense_id')::integer;
  insert into public.payments(cash_desk_id,amount_minor,currency,payment_date,method,payer_name,comment,created_by_user_id,conversion_id,status,operation_type,exchange_rate,amount_tjs,amount_usd,idempotency_key)
  values(desk,(qty*100)::integer,'TJS',dt,coalesce(p_data->>'method','CASH'),'Касса USD (Автоконвертация)','Автоконвертация для оплаты контрагенту',p_actor,fx_id,'ACTIVE','CONVERSION',rate,qty,source_qty,key||':FX-IN') returning id into fx_in;
  update public.payments set reference='ПКО-КОНВ-'||id where id=fx_in;
  converted=true;
 end if;
 r=public.create_atomic_expense(desk,(qty*100)::bigint,cur,dt,coalesce(p_data->>'category','Прочее'),p_data->>'recipient',p_data->>'description',p_actor,
  coalesce(p_data->>'method','CASH'),rate,case when cur='USD' then qty else round(qty/rate,2) end,case when cur='TJS' then qty else null end,key);
 if coalesce((r->>'idempotent')::boolean,false) then raise exception 'РКО уже создан другим запросом. Обновите данные' using errcode='23505'; end if;
 update public.expenses set settlement_party_id=party,settlement_account=account,settlement_updated_by=p_actor,
  conversion_id=fx_id,conversion_expense_id=case when converted then (fx_out->>'expense_id')::integer else null end,
  reference=coalesce(nullif(trim(p_data->>'reference'),''),reference)
 where id=(r->>'expense_id')::integer returning * into e;
 r=to_jsonb(e)||jsonb_build_object('amount',qty);
 if converted then r=r||jsonb_build_object('conversion',jsonb_build_object('has_conversion',true,'conv_expense_id',(fx_out->>'expense_id')::integer,
  'conv_expense_reference','КОНВ-'||(fx_out->>'expense_id'),'conv_payment_id',fx_in,'conv_payment_reference','ПКО-КОНВ-'||fx_in,
  'main_expense_id',e.id,'main_expense_reference',e.reference,'source_currency','USD','source_amount_usd',source_qty,'target_currency','TJS','target_amount_tjs',qty,'exchange_rate',rate)); end if;
 return r;
end $function$;
ALTER FUNCTION "public"."create_expense_with_settlement"(p_data jsonb, p_actor integer) SECURITY INVOKER;
ALTER FUNCTION "public"."create_expense_with_settlement"(p_data jsonb, p_actor integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."create_expense_with_settlement"(p_data jsonb, p_actor integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."create_expense_with_settlement"(p_data jsonb, p_actor integer) TO service_role;
CREATE OR REPLACE FUNCTION public.create_income_payment_atomic(p_payment jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_payment_id INT;
  v_new_payment JSONB;
  v_deal_id INT;
BEGIN
  v_deal_id := (p_payment->>'deal_id')::INT;

  INSERT INTO public.payments (
    deal_id,
    schedule_id,
    amount_minor,
    currency,
    payment_date,
    method,
    settlement_method,
    reference,
    comment,
    payer_name,
    cash_desk_id,
    operation_type,
    exchange_rate,
    amount_usd,
    amount_tjs,
    created_by_user_id,
    status,
    created_at
  )
  VALUES (
    v_deal_id,
    (p_payment->>'schedule_id')::INT,
    (p_payment->>'amount_minor')::INT,
    COALESCE(p_payment->>'currency', 'USD'),
    (p_payment->>'payment_date')::DATE,
    COALESCE(p_payment->>'method', 'CASH'),
    p_payment->>'settlement_method',
    p_payment->>'reference',
    p_payment->>'comment',
    p_payment->>'payer_name',
    (p_payment->>'cash_desk_id')::UUID,
    COALESCE(p_payment->>'operation_type', 'STANDARD'),
    (p_payment->>'exchange_rate')::NUMERIC,
    (p_payment->>'amount_usd')::NUMERIC,
    (p_payment->>'amount_tjs')::NUMERIC,
    (p_payment->>'created_by_user_id')::INT,
    COALESCE(p_payment->>'status', 'ACTIVE'),
    COALESCE((p_payment->>'created_at')::TIMESTAMPTZ, NOW())
  )
  RETURNING id INTO v_payment_id;

  SELECT row_to_json(p)::JSONB INTO v_new_payment
  FROM public.payments p
  WHERE p.id = v_payment_id;

  IF v_deal_id IS NOT NULL THEN
    PERFORM public.recalculate_deal_schedules_internal(v_deal_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment', v_new_payment
  );
END;
$function$;
ALTER FUNCTION "public"."create_income_payment_atomic"(p_payment jsonb) SECURITY INVOKER;
ALTER FUNCTION "public"."create_income_payment_atomic"(p_payment jsonb) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."create_income_payment_atomic"(p_payment jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."create_income_payment_atomic"(p_payment jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_assign_lead_atomic(p_lead_id bigint, p_target_user_id bigint, p_actor_user_id bigint, p_reason text, p_max_capacity integer DEFAULT 25, p_is_manual boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
AS $function$
DECLARE
    v_lead RECORD;
    v_target_user RECORD;
    v_from_user_id BIGINT;
    v_current_workload INT := 0;
    v_assigned_at TIMESTAMPTZ;
    v_assignment_type VARCHAR(50);
BEGIN
    -- 1. Exclusively lock the lead row to prevent concurrent assignment race conditions across instances
    SELECT id, status, responsible_user_id, archived_at
    INTO v_lead
    FROM public.leads
    WHERE id = p_lead_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'LEAD_NOT_FOUND',
            'message', 'Лид не найден'
        );
    END IF;

    IF v_lead.archived_at IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'LEAD_ARCHIVED',
            'message', 'Лид архивирован'
        );
    END IF;

    v_from_user_id := v_lead.responsible_user_id;

    -- 2. Safeguard: if already assigned and automated round-robin is running, preserve existing manager!
    IF NOT p_is_manual AND v_from_user_id IS NOT NULL AND v_from_user_id > 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'status', 'PRESERVED_EXISTING',
            'lead_id', p_lead_id,
            'responsible_user_id', v_from_user_id,
            'message', 'Лид уже закреплен за ответственным менеджером; автоматическая перезапись заблокирована'
        );
    END IF;

    -- 3. If assigning to a specific representative, validate qualification and capacity
    IF p_target_user_id IS NOT NULL THEN
        -- Lock representative row to serialize workload counting across backend instances
        SELECT id, name, role, is_active, is_sales_rep
        INTO v_target_user
        FROM public.users
        WHERE id = p_target_user_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN jsonb_build_object(
                'success', false,
                'error_code', 'USER_NOT_FOUND',
                'message', 'Указанный менеджер не найден'
            );
        END IF;

        IF COALESCE(v_target_user.is_active, 0) <> 1 THEN
            RETURN jsonb_build_object(
                'success', false,
                'error_code', 'USER_INACTIVE',
                'message', 'Учетная запись сотрудника деактивирована'
            );
        END IF;

        IF COALESCE(v_target_user.is_sales_rep, false) IS NOT TRUE THEN
            RETURN jsonb_build_object(
                'success', false,
                'error_code', 'USER_NOT_SALES_REP',
                'message', 'Назначение разрешено только действующему менеджеру продаж'
            );
        END IF;

        -- Count live active open leads for this representative (excluding current lead)
        SELECT COUNT(*)
        INTO v_current_workload
        FROM public.leads
        WHERE responsible_user_id = p_target_user_id
          AND status IN ('NEW', 'IN_PROGRESS', 'NEGOTIATION')
          AND archived_at IS NULL
          AND id <> p_lead_id;

        -- Capacity check: if automated and limit (25) reached, route to pool safely
        IF NOT p_is_manual AND v_current_workload >= p_max_capacity THEN
            p_target_user_id := NULL;
            v_assignment_type := 'POOL_OVERFLOW';
            v_assigned_at := NULL;
        ELSE
            v_assigned_at := NOW();
            IF p_is_manual THEN
                v_assignment_type := 'MANUAL';
            ELSE
                v_assignment_type := 'ROUND_ROBIN';
            END IF;
        END IF;
    ELSE
        -- Return / route to common unassigned pool
        v_assigned_at := NULL;
        v_assignment_type := 'POOL_RETURN';
    END IF;

    -- 4. Atomically update the lead record
    UPDATE public.leads
    SET responsible_user_id = p_target_user_id,
        assigned_at = v_assigned_at,
        reassignment_reason = p_reason,
        updated_at = NOW()::text
    WHERE id = p_lead_id;

    -- 5. Atomically record the assignment transition in audit history
    INSERT INTO public.lead_assignment_history (
        lead_id,
        from_user_id,
        to_user_id,
        assigned_by_user_id,
        assignment_type,
        reason,
        created_at
    ) VALUES (
        p_lead_id,
        v_from_user_id,
        p_target_user_id,
        p_actor_user_id,
        v_assignment_type,
        p_reason,
        NOW()
    );

    RETURN jsonb_build_object(
        'success', true,
        'status', 'ASSIGNED',
        'lead_id', p_lead_id,
        'from_user_id', v_from_user_id,
        'responsible_user_id', p_target_user_id,
        'assignment_type', v_assignment_type,
        'target_workload_after', CASE WHEN p_target_user_id IS NOT NULL THEN v_current_workload + 1 ELSE NULL END,
        'assigned_at', v_assigned_at
    );
END;
$function$;
ALTER FUNCTION "public"."fn_assign_lead_atomic"(p_lead_id bigint, p_target_user_id bigint, p_actor_user_id bigint, p_reason text, p_max_capacity integer, p_is_manual boolean) SECURITY INVOKER;
ALTER FUNCTION "public"."fn_assign_lead_atomic"(p_lead_id bigint, p_target_user_id bigint, p_actor_user_id bigint, p_reason text, p_max_capacity integer, p_is_manual boolean) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."fn_assign_lead_atomic"(p_lead_id bigint, p_target_user_id bigint, p_actor_user_id bigint, p_reason text, p_max_capacity integer, p_is_manual boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."fn_assign_lead_atomic"(p_lead_id bigint, p_target_user_id bigint, p_actor_user_id bigint, p_reason text, p_max_capacity integer, p_is_manual boolean) TO service_role;
CREATE OR REPLACE FUNCTION public.queue_daily_configured_sms(p_date date DEFAULT ((now() AT TIME ZONE 'Asia/Dushanbe'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal'
AS $function$
DECLARE x record; n integer:=0; r public.sms_notification_rules%ROWTYPE;
BEGIN
 IF abs(p_date-(now() AT TIME ZONE 'Asia/Dushanbe')::date)>1 THEN RAISE EXCEPTION 'INVALID_BUSINESS_DATE'; END IF;
 FOR x IN SELECT id FROM public.leads WHERE archived_at IS NULL AND substring(birth_date,6,5)=to_char(p_date,'MM-DD') LOOP
  PERFORM tozon_internal.queue_configured_sms('BIRTHDAY','BIRTHDAY:'||x.id||':'||extract(year FROM p_date)::text,x.id); n:=n+1;
 END LOOP;
 SELECT * INTO r FROM public.sms_notification_rules WHERE event_type='RESERVATION_EXPIRING' AND enabled;
 IF FOUND THEN
 FOR x IN SELECT id,lead_id,reservation_expires_at FROM public.deals WHERE status='RESERVED' AND reservation_expires_at=to_char(p_date+r.offset_days,'YYYY-MM-DD') LOOP
  PERFORM tozon_internal.queue_configured_sms('RESERVATION_EXPIRING','RESERVATION_EXPIRING:'||x.id||':'||x.reservation_expires_at,x.lead_id,x.id); n:=n+1;
 END LOOP;
 END IF;
 SELECT * INTO r FROM public.sms_notification_rules WHERE event_type='DEBTOR_REMINDER' AND enabled;
 IF FOUND THEN
 FOR x IN SELECT DISTINCT d.id,d.lead_id FROM public.deals d JOIN public.deal_payment_schedules s ON s.deal_id=d.id
 WHERE d.status='SIGNED' AND s.due_date<to_char(p_date,'YYYY-MM-DD') AND s.amount_minor>s.paid_amount_minor
 AND NOT EXISTS(SELECT 1 FROM public.sms_events e WHERE e.event_type='DEBTOR_REMINDER' AND e.deal_id=d.id AND e.created_at>=(p_date-r.repeat_days)::timestamptz AND e.status<>'CANCELLED') LOOP
  PERFORM tozon_internal.queue_configured_sms('DEBTOR_REMINDER','DEBTOR_REMINDER:'||x.id||':'||p_date::text,x.lead_id,x.id); n:=n+1;
 END LOOP;
 END IF;
 RETURN n;
END $function$;
ALTER FUNCTION "public"."queue_daily_configured_sms"(p_date date) SECURITY INVOKER;
ALTER FUNCTION "public"."queue_daily_configured_sms"(p_date date) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."queue_daily_configured_sms"(p_date date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."queue_daily_configured_sms"(p_date date) TO service_role;
CREATE OR REPLACE FUNCTION public.recalculate_deal_schedules_internal(p_deal_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pmt RECORD;
  v_pmt_usd_minor INT;
  v_total_active_paid INT := 0;
  v_down_payment_plan INT;
  v_down_payment_covered INT;
  v_pool INT;
  v_sched RECORD;
  v_planned INT;
  v_allocated INT;
  v_paid INT;
  v_remaining INT;
  v_new_status TEXT;
  v_today DATE := CURRENT_DATE;
BEGIN
  IF p_deal_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(down_payment_minor, 0) INTO v_down_payment_plan
  FROM public.deals
  WHERE id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Deal ID % does not exist', p_deal_id;
  END IF;

  FOR v_pmt IN
    SELECT id, amount_minor, currency, exchange_rate, amount_usd
    FROM public.payments
    WHERE deal_id = p_deal_id 
      AND status IN ('ACTIVE', 'POSTED') 
      AND status <> 'VOIDED'
  LOOP
    IF COALESCE(v_pmt.currency, 'USD') = 'USD' THEN
      v_pmt_usd_minor := COALESCE(
        ROUND(v_pmt.amount_usd * 100)::INT,
        v_pmt.amount_minor
      );
    ELSE
      -- Non-USD payment (e.g. TJS)
      IF v_pmt.amount_usd IS NOT NULL AND v_pmt.amount_usd > 0 THEN
        v_pmt_usd_minor := ROUND(v_pmt.amount_usd * 100)::INT;
      ELSIF v_pmt.exchange_rate IS NOT NULL AND v_pmt.exchange_rate > 0 THEN
        v_pmt_usd_minor := ROUND((v_pmt.amount_minor::NUMERIC / 100.0) / v_pmt.exchange_rate * 100)::INT;
      ELSE
        RAISE EXCEPTION 'MISSING_EXCHANGE_RATE: Payment ID % (% %) does not have a valid USD equivalent or exchange rate',
          v_pmt.id, v_pmt.amount_minor, v_pmt.currency;
      END IF;
    END IF;

    v_total_active_paid := v_total_active_paid + v_pmt_usd_minor;
  END LOOP;

  v_down_payment_covered := LEAST(v_total_active_paid, v_down_payment_plan);
  v_pool := GREATEST(0, v_total_active_paid - v_down_payment_covered);

  FOR v_sched IN 
    SELECT id, due_date, amount_minor, paid_amount_minor, status
    FROM public.deal_payment_schedules
    WHERE deal_id = p_deal_id
    ORDER BY due_date::date, id
    FOR UPDATE
  LOOP
    v_planned := COALESCE(v_sched.amount_minor, 0);
    
    IF v_pool >= v_planned THEN
      v_allocated := v_planned;
      v_pool := v_pool - v_planned;
    ELSE
      v_allocated := v_pool;
      v_pool := 0;
    END IF;

    v_paid := LEAST(v_allocated, v_planned);
    v_remaining := GREATEST(0, v_planned - v_paid);

    IF v_remaining = 0 AND v_planned > 0 THEN
      v_new_status := 'PAID';
    ELSIF v_remaining > 0 AND v_sched.due_date::date < v_today THEN
      v_new_status := 'OVERDUE';
    ELSIF v_paid > 0 AND v_paid < v_planned THEN
      v_new_status := 'PARTIAL';
    ELSE
      v_new_status := 'UPCOMING';
    END IF;

    UPDATE public.deal_payment_schedules
    SET paid_amount_minor = v_paid,
        status = v_new_status,
        updated_at = NOW()
    WHERE id = v_sched.id;
  END LOOP;
END;
$function$;
ALTER FUNCTION "public"."recalculate_deal_schedules_internal"(p_deal_id integer) SECURITY INVOKER;
ALTER FUNCTION "public"."recalculate_deal_schedules_internal"(p_deal_id integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."recalculate_deal_schedules_internal"(p_deal_id integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."recalculate_deal_schedules_internal"(p_deal_id integer) TO service_role;
CREATE OR REPLACE FUNCTION public.reconcile_pko_tjs_atomic(p_payment_id integer, p_amount_tjs numeric, p_amount_usd numeric, p_exchange_rate numeric, p_reason text, p_comment text, p_user_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_payment RECORD;
  v_new_audit_id BIGINT;
  v_result JSONB;
  v_existing_usd_credit NUMERIC;
  v_calculated_usd NUMERIC;
  v_diff_usd NUMERIC;
BEGIN
  -- 1. Lock payment row for update
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: ПКО с ID % не найден', p_payment_id;
  END IF;

  -- 2. Verify payment status is ACTIVE
  IF v_payment.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'INVALID_STATUS: Нельзя восстановить сумму для неактивного или аннулированного ПКО (status: %)', v_payment.status;
  END IF;

  -- 3. Idempotency check: verify amount_tjs is currently NULL
  IF v_payment.amount_tjs IS NOT NULL AND v_payment.amount_tjs > 0 THEN
    RAISE EXCEPTION 'ALREADY_RECONCILED: Историческая сумма TJS уже восстановлена (%)', v_payment.amount_tjs;
  END IF;

  -- 4. Validate input TJS amount
  IF p_amount_tjs IS NULL OR p_amount_tjs <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT_TJS: Фактическая сумма TJS должна быть больше 0';
  END IF;

  -- 5. Validate exchange_rate if provided
  IF p_exchange_rate IS NOT NULL AND p_exchange_rate <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXCHANGE_RATE: Исторический курс должен быть больше 0';
  END IF;

  v_existing_usd_credit := (v_payment.amount_minor / 100.0);
  v_calculated_usd := COALESCE(p_amount_usd, v_existing_usd_credit);
  v_diff_usd := CASE WHEN p_amount_usd IS NOT NULL THEN (p_amount_usd - v_existing_usd_credit) ELSE 0 END;

  -- 6. Perform allowed mutation only on amount_tjs, amount_usd, and exchange_rate
  UPDATE public.payments
  SET
    amount_tjs = p_amount_tjs,
    amount_usd = v_calculated_usd,
    exchange_rate = p_exchange_rate
  WHERE id = p_payment_id;

  -- 7. Record audit trail in canonical deal_audit_logs table
  INSERT INTO public.deal_audit_logs (
    deal_id,
    user_id,
    action,
    changes_json,
    created_at
  ) VALUES (
    v_payment.deal_id,
    p_user_id,
    'HISTORICAL_PKO_TJS_RECONCILED',
    jsonb_build_object(
      'payment_id', p_payment_id,
      'reference', v_payment.reference,
      'previous_amount_tjs', v_payment.amount_tjs,
      'new_amount_tjs', p_amount_tjs,
      'existing_amount_minor', v_payment.amount_minor,
      'currency', v_payment.currency,
      'entered_exchange_rate', p_exchange_rate,
      'calculated_usd_equivalent', v_calculated_usd,
      'existing_usd_credit', v_existing_usd_credit,
      'difference_usd', v_diff_usd,
      'reconciliation_reason', p_reason,
      'reconciliation_comment', p_comment,
      'performed_by_user_id', p_user_id,
      'performed_at', NOW()
    ),
    NOW()
  )
  RETURNING id INTO v_new_audit_id;

  -- 8. Return updated payment record
  SELECT jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'amount_tjs', p_amount_tjs,
    'amount_usd', v_calculated_usd,
    'exchange_rate', p_exchange_rate,
    'audit_log_id', v_new_audit_id
  ) INTO v_result;

  RETURN v_result;
END;
$function$;
ALTER FUNCTION "public"."reconcile_pko_tjs_atomic"(p_payment_id integer, p_amount_tjs numeric, p_amount_usd numeric, p_exchange_rate numeric, p_reason text, p_comment text, p_user_id integer) SECURITY INVOKER;
ALTER FUNCTION "public"."reconcile_pko_tjs_atomic"(p_payment_id integer, p_amount_tjs numeric, p_amount_usd numeric, p_exchange_rate numeric, p_reason text, p_comment text, p_user_id integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."reconcile_pko_tjs_atomic"(p_payment_id integer, p_amount_tjs numeric, p_amount_usd numeric, p_exchange_rate numeric, p_reason text, p_comment text, p_user_id integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."reconcile_pko_tjs_atomic"(p_payment_id integer, p_amount_tjs numeric, p_amount_usd numeric, p_exchange_rate numeric, p_reason text, p_comment text, p_user_id integer) TO service_role;
CREATE OR REPLACE FUNCTION public.reconcile_pko_tjs_atomic(p_payment_id integer, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_payment RECORD;
  v_amount_tjs NUMERIC;
  v_exchange_rate NUMERIC;
  v_amount_usd NUMERIC;
  v_reason TEXT;
  v_comment TEXT;
  v_user_id BIGINT;
  v_existing_usd_credit NUMERIC;
  v_calculated_usd NUMERIC;
  v_diff_usd NUMERIC;
  v_new_audit_id BIGINT;
BEGIN
  -- 1. Lock payment row for update
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  -- 2. Check payment existence
  IF v_payment.id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: ПКО #% не найден.', p_payment_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 3. Check payment status
  IF v_payment.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_STATUS: Восстановление доступно только для активных ПКО.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 4. Idempotency check: amount_tjs must be NULL
  IF v_payment.amount_tjs IS NOT NULL THEN
    RAISE EXCEPTION 'HISTORICAL_PKO_ALREADY_RECONCILED: Историческая сумма TJS для ПКО #% уже восстановлена.', p_payment_id
      USING ERRCODE = 'P0003';
  END IF;

  -- 5. Extract and validate input values
  v_amount_tjs := (p_payload->>'amount_tjs')::NUMERIC;
  IF v_amount_tjs IS NULL OR v_amount_tjs <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT_TJS: Сумма в TJS должна быть больше 0.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_payload->>'exchange_rate' IS NOT NULL AND (p_payload->>'exchange_rate')::NUMERIC > 0 THEN
    v_exchange_rate := (p_payload->>'exchange_rate')::NUMERIC;
  ELSE
    v_exchange_rate := NULL;
  END IF;

  v_reason := TRIM(COALESCE(p_payload->>'reason', ''));
  IF v_reason = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: Укажите основание восстановления.'
      USING ERRCODE = 'P0001';
  END IF;

  v_comment := TRIM(COALESCE(p_payload->>'comment', ''));
  IF v_comment = '' THEN
    RAISE EXCEPTION 'COMMENT_REQUIRED: Укажите комментарий / источник данных.'
      USING ERRCODE = 'P0001';
  END IF;

  v_user_id := (p_payload->>'user_id')::BIGINT;

  -- 6. Calculate USD financial equivalents for reference
  v_existing_usd_credit := ROUND((COALESCE(v_payment.amount_minor, 0)::NUMERIC / 100.0), 2);

  IF v_exchange_rate IS NOT NULL AND v_exchange_rate > 0 THEN
    v_calculated_usd := ROUND((v_amount_tjs / v_exchange_rate), 2);
  ELSE
    v_calculated_usd := v_existing_usd_credit;
  END IF;

  v_diff_usd := ROUND((v_calculated_usd - v_existing_usd_credit), 2);

  -- 7. Snapshot update ON PAYMENTS (Immutable: amount_minor, currency, status, deal_id, cash_desk_id, schedule_id)
  UPDATE public.payments
  SET
    amount_tjs = v_amount_tjs,
    exchange_rate = v_exchange_rate,
    amount_usd = v_calculated_usd
  WHERE id = p_payment_id;

  -- 8. Record audit trail in canonical deal_audit_logs table
  INSERT INTO public.deal_audit_logs (
    deal_id,
    user_id,
    action,
    changes_json,
    created_at
  ) VALUES (
    v_payment.deal_id,
    v_user_id,
    'HISTORICAL_PKO_TJS_RECONCILED',
    jsonb_build_object(
      'payment_id', p_payment_id,
      'reference', v_payment.reference,
      'previous_amount_tjs', v_payment.amount_tjs,
      'new_amount_tjs', v_amount_tjs,
      'existing_amount_minor', v_payment.amount_minor,
      'currency', v_payment.currency,
      'entered_exchange_rate', v_exchange_rate,
      'calculated_usd_equivalent', v_calculated_usd,
      'existing_usd_credit', v_existing_usd_credit,
      'difference_usd', v_diff_usd,
      'reconciliation_reason', v_reason,
      'reconciliation_comment', v_comment,
      'performed_by_user_id', v_user_id,
      'performed_at', NOW()
    ),
    NOW()
  )
  RETURNING id INTO v_new_audit_id;

  -- 9. Return structured success result
  RETURN jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'amount_tjs', v_amount_tjs,
    'exchange_rate', v_exchange_rate,
    'amount_usd', v_calculated_usd,
    'amount_minor', v_payment.amount_minor,
    'audit_log_id', v_new_audit_id
  );
END;
$function$;
ALTER FUNCTION "public"."reconcile_pko_tjs_atomic"(p_payment_id integer, p_payload jsonb) SECURITY INVOKER;
ALTER FUNCTION "public"."reconcile_pko_tjs_atomic"(p_payment_id integer, p_payload jsonb) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."reconcile_pko_tjs_atomic"(p_payment_id integer, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."reconcile_pko_tjs_atomic"(p_payment_id integer, p_payload jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.reconcile_pko_tjs_bulk_atomic(p_items jsonb, p_user_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_item JSONB;
  v_payment RECORD;
  v_payment_id INT;
  v_amount_tjs NUMERIC;
  v_exchange_rate NUMERIC;
  v_amount_usd NUMERIC;
  v_reason TEXT;
  v_comment TEXT;
  v_existing_usd_credit NUMERIC;
  v_calculated_usd NUMERIC;
  v_diff_usd NUMERIC;
  v_batch_id TEXT;
  v_reconciled_count INT := 0;
  v_new_audit_id BIGINT;
BEGIN
  -- Generate unique batch ID for audit tracing
  v_batch_id := 'batch_' || EXTRACT(EPOCH FROM NOW())::BIGINT || '_' || floor(random() * 100000)::text;

  -- Validate input array
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'EMPTY_BATCH: Список ПКО для массовой сверки пуст.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Iterate through each item in the batch
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_payment_id := (v_item->>'payment_id')::INT;
    v_amount_tjs := (v_item->>'amount_tjs')::NUMERIC;
    
    IF (v_item->>'exchange_rate') IS NOT NULL AND (v_item->>'exchange_rate')::NUMERIC > 0 THEN
      v_exchange_rate := (v_item->>'exchange_rate')::NUMERIC;
    ELSE
      v_exchange_rate := NULL;
    END IF;

    v_reason := TRIM(COALESCE(v_item->>'reason', 'Бумажный ПКО'));
    v_comment := TRIM(COALESCE(v_item->>'comment', 'Массовое восстановление TJS'));

    -- 1. Lock payment row for update
    SELECT * INTO v_payment
    FROM public.payments
    WHERE id = v_payment_id
    FOR UPDATE;

    -- 2. Validate existence
    IF v_payment.id IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_NOT_FOUND: ПКО #% не найден в базе данных.', v_payment_id
        USING ERRCODE = 'P0002';
    END IF;

    -- 3. Validate status
    IF v_payment.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'INVALID_PAYMENT_STATUS: ПКО #% не активен (status: %). Отмена всей пачки.', v_payment_id, v_payment.status
        USING ERRCODE = 'P0001';
    END IF;

    -- 4. Idempotency check: amount_tjs must be NULL
    IF v_payment.amount_tjs IS NOT NULL THEN
      RAISE EXCEPTION 'HISTORICAL_PKO_ALREADY_RECONCILED: ПКО #% уже имеет восстановленную сумму TJS. Отмена всей пачки.', v_payment_id
        USING ERRCODE = 'P0003';
    END IF;

    -- 5. Validate amount_tjs > 0
    IF v_amount_tjs IS NULL OR v_amount_tjs <= 0 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT_TJS: ПКО #% имеет некорректную сумму TJS (%).', v_payment_id, v_amount_tjs
        USING ERRCODE = 'P0001';
    END IF;

    -- 6. Calculate USD financial equivalents
    v_existing_usd_credit := ROUND((COALESCE(v_payment.amount_minor, 0)::NUMERIC / 100.0), 2);

    IF v_exchange_rate IS NOT NULL AND v_exchange_rate > 0 THEN
      v_calculated_usd := ROUND((v_amount_tjs / v_exchange_rate), 2);
    ELSE
      v_calculated_usd := v_existing_usd_credit;
    END IF;

    v_diff_usd := ROUND((v_calculated_usd - v_existing_usd_credit), 2);

    -- 7. Snapshot update ON PAYMENTS (Immutable: amount_minor, currency, status, deal_id, cash_desk_id)
    UPDATE public.payments
    SET
      amount_tjs = v_amount_tjs,
      exchange_rate = v_exchange_rate,
      amount_usd = v_calculated_usd
    WHERE id = v_payment_id;

    -- 8. Record audit trail in canonical deal_audit_logs table
    INSERT INTO public.deal_audit_logs (
      deal_id,
      user_id,
      action,
      changes_json,
      created_at
    ) VALUES (
      v_payment.deal_id,
      p_user_id,
      'HISTORICAL_PKO_TJS_RECONCILED',
      jsonb_build_object(
        'reconciliation_batch_id', v_batch_id,
        'payment_id', v_payment_id,
        'reference', v_payment.reference,
        'previous_amount_tjs', v_payment.amount_tjs,
        'new_amount_tjs', v_amount_tjs,
        'existing_amount_minor', v_payment.amount_minor,
        'currency', v_payment.currency,
        'entered_exchange_rate', v_exchange_rate,
        'calculated_usd_equivalent', v_calculated_usd,
        'existing_usd_credit', v_existing_usd_credit,
        'difference_usd', v_diff_usd,
        'reconciliation_reason', v_reason,
        'reconciliation_comment', v_comment,
        'performed_by_user_id', p_user_id,
        'performed_at', NOW()
      ),
      NOW()
    )
    RETURNING id INTO v_new_audit_id;

    v_reconciled_count := v_reconciled_count + 1;
  END LOOP;

  -- Return structured batch result
  RETURN jsonb_build_object(
    'success', true,
    'reconciled_count', v_reconciled_count,
    'batch_id', v_batch_id
  );
END;
$function$;
ALTER FUNCTION "public"."reconcile_pko_tjs_bulk_atomic"(p_items jsonb, p_user_id integer) SECURITY INVOKER;
ALTER FUNCTION "public"."reconcile_pko_tjs_bulk_atomic"(p_items jsonb, p_user_id integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."reconcile_pko_tjs_bulk_atomic"(p_items jsonb, p_user_id integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."reconcile_pko_tjs_bulk_atomic"(p_items jsonb, p_user_id integer) TO service_role;
CREATE OR REPLACE FUNCTION public.save_crm_document_settings(p_actor bigint, p_version integer, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_row public.crm_document_settings;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND role='ADMIN' AND is_active=1) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 SELECT * INTO v_row FROM public.crm_document_settings WHERE id=1 FOR UPDATE;
 IF v_row.version <> p_version THEN RAISE EXCEPTION 'STALE_SETTINGS'; END IF;
 INSERT INTO public.crm_document_settings_history(version, data, created_by) VALUES(v_row.version,v_row.data,p_actor);
 UPDATE public.crm_document_settings SET data=p_data, version=version+1, updated_at=now(),updated_by=p_actor WHERE id=1 RETURNING * INTO v_row;
 RETURN to_jsonb(v_row);
END $function$;
ALTER FUNCTION "public"."save_crm_document_settings"(p_actor bigint, p_version integer, p_data jsonb) SECURITY INVOKER;
ALTER FUNCTION "public"."save_crm_document_settings"(p_actor bigint, p_version integer, p_data jsonb) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."save_crm_document_settings"(p_actor bigint, p_version integer, p_data jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."save_crm_document_settings"(p_actor bigint, p_version integer, p_data jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.telegram_finance_claim_worker(p_worker uuid)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  WITH claimed AS (
    UPDATE public.telegram_finance_state
    SET worker_id = p_worker, lease_until = now() + interval '180 seconds'
    WHERE id = 1 AND (lease_until < now() OR worker_id = p_worker)
    RETURNING id
  ) SELECT EXISTS (SELECT 1 FROM claimed);
$function$;
ALTER FUNCTION "public"."telegram_finance_claim_worker"(p_worker uuid) SECURITY INVOKER;
ALTER FUNCTION "public"."telegram_finance_claim_worker"(p_worker uuid) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."telegram_finance_claim_worker"(p_worker uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."telegram_finance_claim_worker"(p_worker uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.telegram_finance_post_expense(p_telegram_id text, p_draft_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  d public.telegram_finance_expense_drafts%ROWTYPE;
  s public.telegram_finance_subscribers%ROWTYPE;
  v_amount bigint; v_currency varchar; v_rate numeric; v_original numeric;
  v_description text; v_result jsonb; v_date date;
BEGIN
  SELECT * INTO d FROM public.telegram_finance_expense_drafts WHERE id=p_draft_id AND telegram_id=p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND'; END IF;
  SELECT * INTO s FROM public.telegram_finance_subscribers WHERE telegram_id=p_telegram_id FOR SHARE;
  IF s.status <> 'APPROVED' OR NOT s.can_create_expense OR s.crm_user_id IS NULL
    OR (s.slot <> 'AKMALKHON' AND s.cash_desk_id IS DISTINCT FROM d.cash_desk_id) THEN
    RAISE EXCEPTION 'CASH_ACCESS_DENIED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=s.crm_user_id AND is_active=1) THEN RAISE EXCEPTION 'CRM_USER_INACTIVE'; END IF;
  IF d.status='POSTED' THEN RETURN d.result; END IF;
  IF d.status<>'DRAFT' OR d.created_at < now()-interval '24 hours' THEN RAISE EXCEPTION 'DRAFT_EXPIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.dictionaries WHERE id=d.cash_desk_id AND type='CASH_DESK' AND is_active=true AND coalesce(code,'')<>'BANK_ACCOUNT' AND name !~* 'бартер') THEN RAISE EXCEPTION 'CASH_DESK_UNAVAILABLE'; END IF;
  v_amount := (d.payload->>'amount_minor')::bigint;
  v_currency := d.payload->>'currency';
  v_date := (d.payload->>'date')::date;
  IF v_amount<=0 OR v_amount>2147483647 OR v_currency NOT IN ('USD','TJS') OR v_date>(now() AT TIME ZONE 'Asia/Dushanbe')::date THEN RAISE EXCEPTION 'INVALID_EXPENSE'; END IF;
  IF coalesce(d.payload->>'category','') IN ('Конвертация валюты','Внутренние перемещения между кассами','INTERNAL_TRANSFER','CURRENCY_CONVERSION') THEN RAISE EXCEPTION 'INVALID_CATEGORY'; END IF;
  v_description := d.payload->>'description';
  IF length(coalesce(v_description,''))<1 OR length(v_description)>1000 OR length(coalesce(d.payload->>'recipient',''))<1 THEN RAISE EXCEPTION 'INVALID_EXPENSE'; END IF;
  v_original := v_amount/100.0;
  IF v_currency='TJS' AND d.payload->>'source_currency'='USD' THEN
    v_rate := (d.payload->>'exchange_rate')::numeric;
    IF v_rate IS NULL OR v_rate<=0 THEN RAISE EXCEPTION 'INVALID_EXCHANGE_RATE'; END IF;
    v_amount := round(v_original/v_rate*100)::bigint;
    IF v_amount<=0 OR v_amount>2147483647 THEN RAISE EXCEPTION 'INVALID_EXPENSE'; END IF;
    v_currency := 'USD';
    v_description := v_description || ' • Оплачено: ' || v_original || ' TJS; списание из USD по курсу ' || v_rate;
  END IF;
  v_result := public.create_atomic_expense(
    p_cash_desk_id=>d.cash_desk_id,p_amount_minor=>v_amount,p_currency=>v_currency,
    p_expense_date=>v_date,p_category=>d.payload->>'category',p_recipient=>d.payload->>'recipient',
    p_description=>v_description,p_user_id=>s.crm_user_id,p_method=>'CASH',
    p_exchange_rate=>v_rate,p_amount_usd=>CASE WHEN v_currency='USD' THEN v_amount/100.0 ELSE NULL END,
    p_amount_tjs=>CASE WHEN d.payload->>'currency'='TJS' THEN v_original ELSE NULL END,
    p_idempotency_key=>('telegram-rko:'||d.id)::varchar
  );
  UPDATE public.telegram_finance_expense_drafts SET status='POSTED',result=v_result WHERE id=d.id;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION "public"."telegram_finance_post_expense"(p_telegram_id text, p_draft_id uuid) SECURITY INVOKER;
ALTER FUNCTION "public"."telegram_finance_post_expense"(p_telegram_id text, p_draft_id uuid) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."telegram_finance_post_expense"(p_telegram_id text, p_draft_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."telegram_finance_post_expense"(p_telegram_id text, p_draft_id uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.telegram_finance_queue_sheet()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
 IF NEW.status='POSTED' AND OLD.status IS DISTINCT FROM 'POSTED' THEN
  INSERT INTO public.telegram_finance_sheet_outbox(id,cash_desk_id,payload)
  VALUES(NEW.id,NEW.cash_desk_id,NEW.payload || jsonb_build_object('reference',NEW.result->>'reference','debit_currency',NEW.result->>'currency','debit_amount',NEW.result->'amount'))
  ON CONFLICT(id) DO NOTHING;
 END IF;
 RETURN NEW;
END;$function$;
ALTER FUNCTION "public"."telegram_finance_queue_sheet"() SECURITY INVOKER;
ALTER FUNCTION "public"."telegram_finance_queue_sheet"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."telegram_finance_queue_sheet"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."telegram_finance_queue_sheet"() TO service_role;
CREATE OR REPLACE FUNCTION public.telegram_finance_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
SELECT jsonb_build_object(
  'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM (
    SELECT id, deal_id, amount_minor, currency, payment_date, settlement_method, reference,
      comment, created_at, status, voided_at, transfer_id, conversion_id, cash_desk_id, operation_type
    FROM public.payments
  ) p), '[]'::jsonb),
  'expenses', COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM (
    SELECT id, amount_minor, currency, expense_date, settlement_method, reference, category, recipient,
      description, created_at, status, voided_at, transfer_id, conversion_id, conversion_expense_id, cash_desk_id, operation_type, amount_tjs, amount_usd, exchange_rate
    FROM public.expenses
  ) e), '[]'::jsonb),
  'deals', COALESCE((SELECT jsonb_agg(to_jsonb(d)) FROM (
    SELECT d.id, d.status, d.currency, d.final_price_minor, d.signed_at, d.deal_date, d.created_at, u.area_m2_x100
    FROM public.deals d LEFT JOIN public.units u ON u.id = d.unit_id
  ) d), '[]'::jsonb),
  'desks', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM (
    SELECT id, name, code FROM public.dictionaries WHERE type = 'CASH_DESK' AND is_active = true ORDER BY sort_order, name
  ) c), '[]'::jsonb)
);
$function$;
ALTER FUNCTION "public"."telegram_finance_snapshot"() SECURITY INVOKER;
ALTER FUNCTION "public"."telegram_finance_snapshot"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."telegram_finance_snapshot"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."telegram_finance_snapshot"() TO service_role;
CREATE OR REPLACE FUNCTION public.terminate_deal_atomic(p_deal_id bigint, p_user_id bigint, p_reason text, p_comment text DEFAULT NULL::text, p_refund_amount_minor bigint DEFAULT 0, p_retention_reason text DEFAULT NULL::text, p_cash_desk_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_effective_date text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    v_deal RECORD;
    v_paid_total_minor BIGINT := 0;
    v_retained_amount_minor BIGINT := 0;
    v_refund_expense_id BIGINT := NULL;
    v_cash_desk_exists BOOLEAN := FALSE;
    v_effective_date TEXT;
    v_idempotency_key TEXT;
    v_contract_num TEXT;
    v_updated_deal JSONB;
BEGIN
    -- A. Lock and fetch existing deal (Row-level lock FOR UPDATE)
    SELECT * INTO v_deal FROM public.deals WHERE id = p_deal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка не найдена' USING ERRCODE = 'P0002';
    END IF;

    -- Concurrency guard: Re-read status after acquiring lock
    IF v_deal.status = 'CANCELLED' THEN
        RAISE EXCEPTION 'DEAL_ALREADY_CANCELLED: Сделка уже расторгнута / отменена' USING ERRCODE = 'P0003';
    END IF;

    -- Lock associated unit
    PERFORM 1 FROM public.units WHERE id = v_deal.unit_id FOR UPDATE;

    -- B. Compute actual paid total from active payments in DB (Source of Truth)
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_paid_total_minor 
    FROM public.payments 
    WHERE deal_id = p_deal_id AND status <> 'VOIDED';

    -- C. Validate reason
    IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
        RAISE EXCEPTION 'TERMINATION_REASON_REQUIRED: Причина расторжения договора обязательна' USING ERRCODE = 'P0004';
    END IF;

    -- D. Validate refund & retention invariants
    IF p_refund_amount_minor < 0 THEN
        RAISE EXCEPTION 'INVALID_REFUND_AMOUNT: Сумма возврата не может быть отрицательной' USING ERRCODE = 'P0005';
    END IF;

    IF v_paid_total_minor = 0 THEN
        IF p_refund_amount_minor > 0 THEN
            RAISE EXCEPTION 'REFUND_NOT_ALLOWED_ZERO_PAID: По данной сделке нет фактических платежей. Сумма возврата должна быть 0' USING ERRCODE = 'P0006';
        END IF;
    ELSE
        IF p_refund_amount_minor > v_paid_total_minor THEN
            RAISE EXCEPTION 'REFUND_EXCEEDS_PAID: Сумма возврата не может превышать фактически полученную сумму' USING ERRCODE = 'P0007';
        END IF;
    END IF;

    v_retained_amount_minor := v_paid_total_minor - p_refund_amount_minor;

    IF v_retained_amount_minor > 0 AND (p_retention_reason IS NULL OR TRIM(p_retention_reason) = '') THEN
        RAISE EXCEPTION 'RETENTION_REASON_REQUIRED: При наличии удержания необходимо указать основание удержания' USING ERRCODE = 'P0008';
    END IF;

    -- E. Validate Cash Desk if refund > 0
    IF p_refund_amount_minor > 0 THEN
        IF p_cash_desk_id IS NULL THEN
            RAISE EXCEPTION 'CASH_DESK_REQUIRED: Касса списания обязательна при возврате средств' USING ERRCODE = 'P0009';
        END IF;

        SELECT EXISTS (
            SELECT 1 FROM public.dictionaries WHERE id = p_cash_desk_id AND type = 'CASH_DESK' AND is_active = true
        ) INTO v_cash_desk_exists;

        IF NOT v_cash_desk_exists THEN
            RAISE EXCEPTION 'INVALID_CASH_DESK: Указанная касса списания не найдена или неактивна' USING ERRCODE = 'P0010';
        END IF;
    END IF;

    -- F. Deterministic Idempotency Key (Guarantees DB-level UNIQUE protection)
    v_idempotency_key := COALESCE(NULLIF(TRIM(p_idempotency_key), ''), 'TERMINATE_DEAL_' || p_deal_id::TEXT);
    v_effective_date := COALESCE(NULLIF(TRIM(p_effective_date), ''), CURRENT_DATE::TEXT);
    v_contract_num := COALESCE(v_deal.contract_number, p_deal_id::TEXT);

    -- G. Insert Refund RKO if refund > 0 (Guarded by DB-level UNIQUE constraint on idempotency_key)
    IF p_refund_amount_minor > 0 THEN
        -- Check if already inserted via idempotency key
        SELECT id INTO v_refund_expense_id 
        FROM public.expenses 
        WHERE idempotency_key = v_idempotency_key;

        IF v_refund_expense_id IS NULL THEN
            INSERT INTO public.expenses (
                category,
                amount_minor,
                currency,
                expense_date,
                recipient,
                description,
                reference,
                cash_desk_id,
                idempotency_key,
                created_by_user_id,
                deal_id,
                status,
                created_at
            ) VALUES (
                'Возврат средств (расторжение договора)',
                p_refund_amount_minor,
                v_deal.currency,
                v_effective_date,
                'Клиент по дог. №' || v_contract_num,
                TRIM('Возврат денежных средств при расторжении договора №' || v_contract_num || '. ' || COALESCE(p_comment, '')),
                'РКО-ВОЗВРАТ-' || v_contract_num,
                p_cash_desk_id,
                v_idempotency_key,
                p_user_id,
                p_deal_id,
                'ACTIVE',
                NOW()
            )
            RETURNING id INTO v_refund_expense_id;
        END IF;
    END IF;

    -- H. Update Deal state to CANCELLED and store termination metadata
    UPDATE public.deals
    SET
        status = 'CANCELLED',
        cancelled_at = NOW(),
        cancellation_reason = p_reason,
        paid_at_termination_minor = v_paid_total_minor,
        refund_amount_minor = p_refund_amount_minor,
        retained_amount_minor = v_retained_amount_minor,
        refund_expense_id = v_refund_expense_id,
        terminated_by_user_id = p_user_id,
        updated_at = NOW()
    WHERE id = p_deal_id;

    -- I. Update Unit state to AVAILABLE
    UPDATE public.units
    SET
        status = 'AVAILABLE',
        updated_at = NOW()
    WHERE id = v_deal.unit_id;

    -- J. Update deal_payment_schedules preserving historical plan & paid amounts
    --    Unpaid / future obligations transition to CANCELLED.
    --    PARTIAL schedules keep original amount_minor (planned) and paid_amount_minor (paid fact).
    UPDATE public.deal_payment_schedules
    SET
        status = 'CANCELLED',
        updated_at = NOW()
    WHERE deal_id = p_deal_id 
      AND status NOT IN ('PAID');

    -- K. Log Audit Trail Entry
    INSERT INTO public.deal_audit_logs (
        deal_id,
        user_id,
        action,
        changes_json,
        created_at
    ) VALUES (
        p_deal_id,
        p_user_id,
        'TERMINATE_DEAL',
        jsonb_build_object(
            'contract_number', v_deal.contract_number,
            'unit_id', v_deal.unit_id,
            'lead_id', v_deal.lead_id,
            'currency', v_deal.currency,
            'contract_total_minor', v_deal.final_price_minor,
            'paid_total_minor', v_paid_total_minor,
            'refund_amount_minor', p_refund_amount_minor,
            'retained_amount_minor', v_retained_amount_minor,
            'refund_expense_id', v_refund_expense_id,
            'cash_desk_id', p_cash_desk_id,
            'reason', p_reason,
            'retention_reason', p_retention_reason,
            'comment', p_comment,
            'idempotency_key', v_idempotency_key
        ),
        NOW()
    );

    SELECT to_jsonb(d.*) INTO v_updated_deal FROM public.deals d WHERE d.id = p_deal_id;
    RETURN v_updated_deal;
END;
$function$;
ALTER FUNCTION "public"."terminate_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_reason text, p_comment text, p_refund_amount_minor bigint, p_retention_reason text, p_cash_desk_id uuid, p_idempotency_key text, p_effective_date text) SECURITY INVOKER;
ALTER FUNCTION "public"."terminate_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_reason text, p_comment text, p_refund_amount_minor bigint, p_retention_reason text, p_cash_desk_id uuid, p_idempotency_key text, p_effective_date text) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."terminate_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_reason text, p_comment text, p_refund_amount_minor bigint, p_retention_reason text, p_cash_desk_id uuid, p_idempotency_key text, p_effective_date text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."terminate_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_reason text, p_comment text, p_refund_amount_minor bigint, p_retention_reason text, p_cash_desk_id uuid, p_idempotency_key text, p_effective_date text) TO service_role;
CREATE OR REPLACE FUNCTION public.update_deal_atomic(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb DEFAULT NULL::jsonb, p_schedules_json jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
AS $function$
DECLARE
    v_deal RECORD;
    v_payments_count INT;
    v_has_financial_keys BOOLEAN := FALSE;
    v_key TEXT;
    v_old_deal JSONB;
    v_new_deal JSONB;
BEGIN
    SELECT * INTO v_deal FROM deals WHERE id = p_deal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка не найдена' USING ERRCODE = 'P0002';
    END IF;

    v_old_deal := to_jsonb(v_deal);

    SELECT COUNT(*) INTO v_payments_count FROM payments WHERE deal_id = p_deal_id;

    IF v_payments_count > 0 THEN
        FOR v_key IN SELECT jsonb_object_keys(p_updates_json)
        LOOP
            IF v_key IN ('base_price_minor', 'discount_minor', 'final_price_minor', 'deal_price_per_m2_minor', 'down_payment_minor', 'installment_months', 'exchange_rate', 'payment_type') THEN
                v_has_financial_keys := TRUE;
                EXIT;
            END IF;
        END LOOP;

        IF v_has_financial_keys THEN
            RAISE EXCEPTION 'PAID_DEAL_FINANCIAL_EDIT_BLOCKED: Запрещено изменять финансовые условия сделки, по которой уже проведены фактические платежи' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    UPDATE deals
    SET
        deal_date = COALESCE((p_updates_json->>'deal_date'), deal_date),
        contract_number = COALESCE((p_updates_json->>'contract_number'), contract_number),
        responsible_user_id = CASE 
            WHEN p_updates_json ? 'responsible_user_id' THEN (p_updates_json->>'responsible_user_id')::BIGINT 
            ELSE responsible_user_id 
        END,
        reservation_expires_at = CASE 
            WHEN p_updates_json ? 'reservation_expires_at' THEN (p_updates_json->>'reservation_expires_at') 
            ELSE reservation_expires_at 
        END,
        payment_type = COALESCE((p_updates_json->>'payment_type'), payment_type),
        installment_months = COALESCE((p_updates_json->>'installment_months')::INT, installment_months),
        barter_description = CASE 
            WHEN p_updates_json ? 'barter_description' THEN (p_updates_json->>'barter_description') 
            ELSE barter_description 
        END,
        barter_amount_minor = COALESCE((p_updates_json->>'barter_amount_minor')::BIGINT, barter_amount_minor),
        base_price_minor = COALESCE((p_updates_json->>'base_price_minor')::BIGINT, base_price_minor),
        discount_minor = COALESCE((p_updates_json->>'discount_minor')::BIGINT, discount_minor),
        final_price_minor = COALESCE((p_updates_json->>'final_price_minor')::BIGINT, final_price_minor),
        deal_price_per_m2_minor = COALESCE((p_updates_json->>'deal_price_per_m2_minor')::BIGINT, deal_price_per_m2_minor),
        down_payment_minor = COALESCE((p_updates_json->>'down_payment_minor')::BIGINT, down_payment_minor),
        exchange_rate = COALESCE((p_updates_json->>'exchange_rate')::NUMERIC, exchange_rate),
        updated_at = NOW()
    WHERE id = p_deal_id;

    IF p_lead_updates_json IS NOT NULL AND jsonb_typeof(p_lead_updates_json) = 'object' THEN
        UPDATE leads
        SET
            full_name = COALESCE((p_lead_updates_json->>'full_name'), full_name),
            phone = COALESCE((p_lead_updates_json->>'phone'), phone),
            passport_series = CASE WHEN p_lead_updates_json ? 'passport_series' THEN (p_lead_updates_json->>'passport_series') ELSE passport_series END,
            passport_number = CASE WHEN p_lead_updates_json ? 'passport_number' THEN (p_lead_updates_json->>'passport_number') ELSE passport_number END,
            inn = CASE WHEN p_lead_updates_json ? 'inn' THEN (p_lead_updates_json->>'inn') ELSE inn END,
            updated_at = NOW()
        WHERE id = v_deal.lead_id;
    END IF;

    IF p_schedules_json IS NOT NULL AND jsonb_typeof(p_schedules_json) = 'array' THEN
        DELETE FROM deal_payment_schedules WHERE deal_id = p_deal_id;

        IF jsonb_array_length(p_schedules_json) > 0 THEN
            INSERT INTO deal_payment_schedules (
                deal_id, payment_number, due_date, amount_minor, paid_amount_minor, status, created_at, updated_at
            )
            SELECT 
                p_deal_id,
                (elem->>'payment_number')::INT,
                (elem->>'due_date'),
                (elem->>'amount_minor')::BIGINT,
                COALESCE((elem->>'paid_amount_minor')::BIGINT, 0),
                COALESCE((elem->>'status'), 'UPCOMING'),
                NOW(),
                NOW()
            FROM jsonb_array_elements(p_schedules_json) AS elem;
        END IF;
    END IF;

    INSERT INTO deal_audit_logs (deal_id, user_id, action, changes_json, created_at)
    VALUES (
        p_deal_id,
        p_user_id,
        'UPDATE_DEAL',
        jsonb_build_object('old', v_old_deal, 'updates', p_updates_json),
        NOW()
    );

    SELECT to_jsonb(d.*) INTO v_new_deal FROM deals d WHERE d.id = p_deal_id;
    RETURN v_new_deal;
END;
$function$;
ALTER FUNCTION "public"."update_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb, p_schedules_json jsonb) SECURITY INVOKER;
ALTER FUNCTION "public"."update_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb, p_schedules_json jsonb) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."update_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb, p_schedules_json jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."update_deal_atomic"(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb, p_schedules_json jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.update_deal_vehicle_atomic(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb DEFAULT NULL::jsonb, p_schedules_json jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_vehicle jsonb;
  v_payment_type text;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_user_id AND role='ADMIN' AND is_active=1) THEN
    RAISE EXCEPTION 'Редактирование автомобиля доступно только администратору';
  END IF;
  IF jsonb_typeof(p_updates_json) IS DISTINCT FROM 'object' OR NOT (p_updates_json ? 'vehicle_details') THEN
    RAISE EXCEPTION 'Укажите данные автомобиля';
  END IF;
  SELECT payment_type INTO v_payment_type FROM public.deals WHERE id=p_deal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Сделка не найдена'; END IF;
  IF coalesce(p_updates_json->>'payment_type', v_payment_type) <> 'PARTIAL_BARTER' THEN
    RAISE EXCEPTION 'Данные автомобиля доступны для сделки Бартер + Доплата';
  END IF;
  v_vehicle := nullif(p_updates_json->'vehicle_details','null'::jsonb);
  IF v_vehicle IS NOT NULL THEN
    IF jsonb_typeof(v_vehicle) <> 'object' THEN RAISE EXCEPTION 'Некорректные данные автомобиля'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(v_vehicle) AS e(key,value)
      WHERE e.key NOT IN ('brand_model','production_year','color','registration_number','vin','registration_certificate','mileage_km','handover_date','condition','accessories','encumbrances')
        OR jsonb_typeof(e.value) <> 'string') THEN
      RAISE EXCEPTION 'Недопустимое поле данных автомобиля';
    END IF;
  END IF;
  -- Existing function enforces paid financial locks, saves metadata and records all input keys in the audit.
  PERFORM public.update_deal_atomic(p_deal_id,p_user_id,p_updates_json,p_lead_updates_json,p_schedules_json);
  UPDATE public.deals SET vehicle_details=v_vehicle WHERE id=p_deal_id;
  SELECT to_jsonb(d) INTO v_result FROM public.deals d WHERE id=p_deal_id;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION "public"."update_deal_vehicle_atomic"(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb, p_schedules_json jsonb) SECURITY INVOKER;
ALTER FUNCTION "public"."update_deal_vehicle_atomic"(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb, p_schedules_json jsonb) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."update_deal_vehicle_atomic"(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb, p_schedules_json jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."update_deal_vehicle_atomic"(p_deal_id bigint, p_user_id bigint, p_updates_json jsonb, p_lead_updates_json jsonb, p_schedules_json jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.update_income_payment_atomic(p_payment_id integer, p_payment_update jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated_payment JSONB;
  v_deal_id INT;
BEGIN
  UPDATE public.payments
  SET amount_minor = CASE WHEN p_payment_update ? 'amount_minor' AND p_payment_update->>'amount_minor' IS NOT NULL THEN (p_payment_update->>'amount_minor')::INT ELSE amount_minor END,
      payment_date = CASE WHEN p_payment_update ? 'payment_date' AND p_payment_update->>'payment_date' IS NOT NULL THEN (p_payment_update->>'payment_date')::TEXT ELSE payment_date END,
      comment = CASE WHEN p_payment_update ? 'comment' AND p_payment_update->>'comment' IS NOT NULL THEN p_payment_update->>'comment' ELSE comment END,
      cash_desk_id = CASE WHEN p_payment_update ? 'cash_desk_id' AND p_payment_update->>'cash_desk_id' IS NOT NULL THEN (p_payment_update->>'cash_desk_id')::UUID ELSE cash_desk_id END,
      payer_name = CASE WHEN p_payment_update ? 'payer_name' AND p_payment_update->>'payer_name' IS NOT NULL THEN p_payment_update->>'payer_name' ELSE payer_name END,
      currency = CASE WHEN p_payment_update ? 'currency' AND p_payment_update->>'currency' IS NOT NULL THEN p_payment_update->>'currency' ELSE currency END,
      method = CASE WHEN p_payment_update ? 'method' AND p_payment_update->>'method' IS NOT NULL THEN p_payment_update->>'method' ELSE method END,
      reference = CASE WHEN p_payment_update ? 'reference' AND p_payment_update->>'reference' IS NOT NULL THEN p_payment_update->>'reference' ELSE reference END
  WHERE id = p_payment_id
  RETURNING deal_id INTO v_deal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROW_NOT_FOUND: Payment ID % does not exist', p_payment_id;
  END IF;

  SELECT row_to_json(p)::JSONB INTO v_updated_payment
  FROM public.payments p
  WHERE p.id = p_payment_id;

  IF v_deal_id IS NOT NULL THEN
    PERFORM public.recalculate_deal_schedules_internal(v_deal_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment', v_updated_payment
  );
END;
$function$;
ALTER FUNCTION "public"."update_income_payment_atomic"(p_payment_id integer, p_payment_update jsonb) SECURITY INVOKER;
ALTER FUNCTION "public"."update_income_payment_atomic"(p_payment_id integer, p_payment_update jsonb) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."update_income_payment_atomic"(p_payment_id integer, p_payment_update jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."update_income_payment_atomic"(p_payment_id integer, p_payment_update jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.void_income_payment_atomic(p_payment_id integer, p_user_id integer DEFAULT NULL::integer, p_void_reason text DEFAULT 'Annulled via CRM'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deal_id INT;
  v_voided_payment JSONB;
BEGIN
  UPDATE public.payments
  SET status = 'VOIDED',
      voided_at = NOW(),
      voided_by = p_user_id,
      void_reason = p_void_reason
  WHERE id = p_payment_id
  RETURNING deal_id INTO v_deal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROW_NOT_FOUND: Payment ID % does not exist', p_payment_id;
  END IF;

  SELECT row_to_json(p)::JSONB INTO v_voided_payment
  FROM public.payments p
  WHERE p.id = p_payment_id;

  IF v_deal_id IS NOT NULL THEN
    PERFORM public.recalculate_deal_schedules_internal(v_deal_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment', v_voided_payment
  );
END;
$function$;
ALTER FUNCTION "public"."void_income_payment_atomic"(p_payment_id integer, p_user_id integer, p_void_reason text) SECURITY INVOKER;
ALTER FUNCTION "public"."void_income_payment_atomic"(p_payment_id integer, p_user_id integer, p_void_reason text) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "public"."void_income_payment_atomic"(p_payment_id integer, p_user_id integer, p_void_reason text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."void_income_payment_atomic"(p_payment_id integer, p_user_id integer, p_void_reason text) TO service_role;
CREATE OR REPLACE FUNCTION tozon_internal.assign_customer_pko_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
DECLARE n bigint;
BEGIN
 IF TG_OP='DELETE' THEN
   IF OLD.customer_pko_number IS NOT NULL OR tozon_internal.is_customer_pko(to_jsonb(OLD)) THEN
     RAISE EXCEPTION 'CUSTOMER_PKO_MUST_BE_VOIDED: Аннулируйте ПКО вместо удаления';
   END IF;
   RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.customer_pko_number IS NOT NULL OR tozon_internal.is_customer_pko(to_jsonb(OLD)) THEN
     IF NEW.reference IS DISTINCT FROM OLD.reference
        OR NEW.document_number IS DISTINCT FROM OLD.document_number
        OR NEW.customer_pko_number IS DISTINCT FROM OLD.customer_pko_number
        OR NEW.deal_id IS DISTINCT FROM OLD.deal_id
        OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
        OR NEW.settlement_method IS DISTINCT FROM OLD.settlement_method
        OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
        OR NEW.conversion_id IS DISTINCT FROM OLD.conversion_id THEN
       RAISE EXCEPTION 'CUSTOMER_PKO_NUMBER_IMMUTABLE: Номер и принадлежность ПКО покупателя сохраняются';
     END IF;
   ELSIF NEW.customer_pko_number IS NOT NULL OR tozon_internal.is_customer_pko(to_jsonb(NEW)) THEN
     RAISE EXCEPTION 'CUSTOMER_PKO_REQUIRES_NEW_DOCUMENT: Оформите отдельный ПКО покупателя';
   END IF;
   RETURN NEW;
 END IF;
 IF NOT tozon_internal.is_customer_pko(to_jsonb(NEW)) THEN
   NEW.customer_pko_number:=NULL;
   RETURN NEW;
 END IF;
 -- The single row lock serializes all currencies, cash desks and app instances.
 LOOP
   UPDATE tozon_internal.customer_pko_counter SET last_number=last_number+1
   WHERE id=1 RETURNING last_number INTO n;
   IF n IS NULL THEN RAISE EXCEPTION 'CUSTOMER_PKO_COUNTER_MISSING'; END IF;
   EXIT WHEN NOT EXISTS (
     SELECT 1 FROM public.payments p WHERE
       p.customer_pko_number=n OR
       ltrim(regexp_replace(upper(trim(p.reference)), '^ПКО[- ]*',''),'0')=n::text OR
       ltrim(regexp_replace(upper(trim(p.document_number)), '^ПКО[- ]*',''),'0')=n::text
   );
 END LOOP;
 NEW.customer_pko_number:=n;
 NEW.reference:='ПКО-'||n::text;
 NEW.document_number:=NEW.reference;
 RETURN NEW;
END $function$;
ALTER FUNCTION "tozon_internal"."assign_customer_pko_number"() SECURITY INVOKER;
ALTER FUNCTION "tozon_internal"."assign_customer_pko_number"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "tozon_internal"."assign_customer_pko_number"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "tozon_internal"."assign_customer_pko_number"() TO service_role;
CREATE OR REPLACE FUNCTION tozon_internal.assign_document_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_data jsonb; v_pattern text; v_kind text; v_number text; v_project text := ''; v_unit text := ''; v_building text := '';
BEGIN
 IF TG_TABLE_NAME='deals' THEN v_kind:='CONTRACT'; ELSE v_kind:=CASE WHEN TG_TABLE_NAME='payments' THEN 'PKO' ELSE 'RKO' END; END IF;
 SELECT data INTO v_data FROM public.crm_document_settings WHERE id=1;
 v_pattern := v_data->'numbering'->>v_kind;
 IF v_pattern IS NULL OR v_pattern='' THEN RETURN NEW; END IF;
 IF length(v_pattern)>100 OR (position('{id}' in v_pattern)=0 AND position('{id4}' in v_pattern)=0) THEN RAISE EXCEPTION 'INVALID_NUMBER_PATTERN'; END IF;
 IF TG_TABLE_NAME='deals' THEN
   SELECT p.code,u.unit_number,b.name INTO v_project,v_unit,v_building FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects p ON p.id=b.project_id WHERE u.id=NEW.unit_id;
 END IF;
 v_number:=replace(replace(replace(replace(replace(replace(v_pattern,'{id}',NEW.id::text),'{id4}', CASE WHEN length(NEW.id::text)<4 THEN lpad(NEW.id::text,4,'0') ELSE NEW.id::text END),'{year}',extract(year FROM COALESCE(CASE WHEN TG_TABLE_NAME='deals' THEN (to_jsonb(NEW)->>'deal_date')::date WHEN TG_TABLE_NAME='payments' THEN (to_jsonb(NEW)->>'payment_date')::date ELSE (to_jsonb(NEW)->>'expense_date')::date END, (now() AT TIME ZONE 'Asia/Dushanbe')::date))::text),'{project_code}',coalesce(v_project,'')),'{unit}',coalesce(v_unit,'')),'{building}',coalesce(v_building,''));
 IF v_number ~ '[{}]' OR length(v_number)>64 THEN RAISE EXCEPTION 'INVALID_NUMBER_PATTERN'; END IF;
 IF TG_TABLE_NAME='deals' THEN
   IF EXISTS(SELECT 1 FROM public.deals WHERE contract_number=v_number) THEN RAISE EXCEPTION 'NUMBER_ALREADY_EXISTS'; END IF;
   NEW.contract_number:=v_number;
 ELSE NEW.document_number:=v_number;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION "tozon_internal"."assign_document_number"() SECURITY INVOKER;
ALTER FUNCTION "tozon_internal"."assign_document_number"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "tozon_internal"."assign_document_number"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "tozon_internal"."assign_document_number"() TO service_role;
CREATE OR REPLACE FUNCTION tozon_internal.audit_sms_settings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 INSERT INTO public.sms_settings_history(entity,entity_id,previous,current)
 VALUES(TG_TABLE_NAME,CASE WHEN TG_TABLE_NAME='sms_notification_rules' THEN to_jsonb(NEW)->>'event_type' ELSE to_jsonb(NEW)->>'id' END,
 CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
 RETURN NEW;
END $function$;
ALTER FUNCTION "tozon_internal"."audit_sms_settings"() SECURITY INVOKER;
ALTER FUNCTION "tozon_internal"."audit_sms_settings"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "tozon_internal"."audit_sms_settings"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "tozon_internal"."audit_sms_settings"() TO service_role;
CREATE OR REPLACE FUNCTION tozon_internal.is_customer_pko(p jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
 SELECT p->>'deal_id' IS NOT NULL
   AND coalesce(p->>'operation_type','STANDARD')='STANDARD'
   AND coalesce(p->>'settlement_method','CASH')='CASH'
   AND p->>'transfer_id' IS NULL AND p->>'conversion_id' IS NULL
$function$;
ALTER FUNCTION "tozon_internal"."is_customer_pko"(p jsonb) SECURITY INVOKER;
ALTER FUNCTION "tozon_internal"."is_customer_pko"(p jsonb) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "tozon_internal"."is_customer_pko"(p jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "tozon_internal"."is_customer_pko"(p jsonb) TO service_role;
CREATE OR REPLACE FUNCTION tozon_internal.queue_configured_sms(p_type text, p_key text, p_client integer, p_deal integer DEFAULT NULL::integer, p_payment integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE r public.sms_notification_rules%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.sms_notification_rules WHERE event_type=p_type AND enabled;
 IF NOT FOUND OR p_client IS NULL THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sms_templates WHERE code=r.template_code AND is_active) THEN RETURN; END IF;
 INSERT INTO public.sms_events(event_type,idempotency_key,mode,client_id,deal_id,payment_id,template_code,payload_json)
 VALUES(p_type,p_key,'CONFIRM',p_client,p_deal,p_payment,r.template_code,jsonb_build_object('managed_rule',true))
 ON CONFLICT(idempotency_key) DO NOTHING;
END $function$;
ALTER FUNCTION "tozon_internal"."queue_configured_sms"(p_type text, p_key text, p_client integer, p_deal integer, p_payment integer) SECURITY INVOKER;
ALTER FUNCTION "tozon_internal"."queue_configured_sms"(p_type text, p_key text, p_client integer, p_deal integer, p_payment integer) SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "tozon_internal"."queue_configured_sms"(p_type text, p_key text, p_client integer, p_deal integer, p_payment integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "tozon_internal"."queue_configured_sms"(p_type text, p_key text, p_client integer, p_deal integer, p_payment integer) TO service_role;
CREATE OR REPLACE FUNCTION tozon_internal.queue_deal_sms()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal'
AS $function$
DECLARE typ text;
BEGIN
 IF TG_OP='INSERT' THEN
  typ:=CASE NEW.status WHEN 'RESERVED' THEN 'RESERVATION_CREATED' WHEN 'SIGNED' THEN 'CONTRACT_CREATED' END;
 ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
  typ:=CASE WHEN NEW.status='SIGNED' THEN 'CONTRACT_CREATED' WHEN NEW.status='CANCELLED' AND OLD.status='RESERVED' THEN 'RESERVATION_CANCELLED' WHEN NEW.status='CANCELLED' THEN 'CONTRACT_TERMINATED' END;
 ELSIF NEW.status='SIGNED' AND (NEW.final_price_minor IS DISTINCT FROM OLD.final_price_minor OR NEW.unit_id IS DISTINCT FROM OLD.unit_id) THEN
  typ:='CONTRACT_CHANGED';
 END IF;
 IF typ IS NOT NULL THEN
  PERFORM tozon_internal.queue_configured_sms(typ,typ||':'||NEW.id||':'||CASE WHEN typ='CONTRACT_CHANGED' THEN txid_current()::text ELSE 'created' END,NEW.lead_id,NEW.id);
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION "tozon_internal"."queue_deal_sms"() SECURITY INVOKER;
ALTER FUNCTION "tozon_internal"."queue_deal_sms"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "tozon_internal"."queue_deal_sms"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "tozon_internal"."queue_deal_sms"() TO service_role;
CREATE OR REPLACE FUNCTION tozon_internal.queue_payment_sms()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal'
AS $function$
DECLARE d public.deals%ROWTYPE; typ text;
BEGIN
 IF NEW.deal_id IS NULL OR COALESCE(NEW.operation_type,'STANDARD') NOT IN ('STANDARD','INCOME','DEAL_PAYMENT') THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND NEW.status IS DISTINCT FROM 'VOIDED' THEN typ:='PAYMENT_RECEIVED';
 ELSIF TG_OP='UPDATE' AND OLD.status IS DISTINCT FROM 'VOIDED' AND NEW.status='VOIDED' THEN typ:='PAYMENT_CANCELLED'; END IF;
 SELECT * INTO d FROM public.deals WHERE id=NEW.deal_id;
 IF typ IS NOT NULL THEN PERFORM tozon_internal.queue_configured_sms(typ,typ||':'||NEW.id,d.lead_id,d.id,NEW.id); END IF;
 IF typ='PAYMENT_RECEIVED' AND d.status='SIGNED' AND d.final_price_minor>0 AND (SELECT COALESCE(sum(amount_minor),0) FROM public.payments WHERE deal_id=d.id AND status IS DISTINCT FROM 'VOIDED')>=d.final_price_minor THEN
  PERFORM tozon_internal.queue_configured_sms('CONTRACT_PAID','CONTRACT_PAID:'||d.id,d.lead_id,d.id);
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION "tozon_internal"."queue_payment_sms"() SECURITY INVOKER;
ALTER FUNCTION "tozon_internal"."queue_payment_sms"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "tozon_internal"."queue_payment_sms"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "tozon_internal"."queue_payment_sms"() TO service_role;
CREATE OR REPLACE FUNCTION tozon_internal.queue_schedule_sms()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal'
AS $function$
DECLARE d public.deals%ROWTYPE;
BEGIN
 IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.due_date IS DISTINCT FROM OLD.due_date THEN
 SELECT * INTO d FROM public.deals WHERE id=NEW.deal_id AND status='SIGNED';
 IF FOUND THEN PERFORM tozon_internal.queue_configured_sms('SCHEDULE_CHANGED','SCHEDULE_CHANGED:'||d.id||':'||txid_current(),d.lead_id,d.id); END IF;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION "tozon_internal"."queue_schedule_sms"() SECURITY INVOKER;
ALTER FUNCTION "tozon_internal"."queue_schedule_sms"() SET search_path = pg_catalog, public, tozon_internal, pg_temp;
REVOKE ALL ON FUNCTION "tozon_internal"."queue_schedule_sms"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "tozon_internal"."queue_schedule_sms"() TO service_role;
SET LOCAL check_function_bodies = on;
CREATE TRIGGER construction_document_guard BEFORE DELETE OR UPDATE ON construction_documents FOR EACH ROW EXECUTE FUNCTION construction_document_guard();
CREATE TRIGGER construction_prevent_double_expense_settlement BEFORE INSERT OR UPDATE ON construction_documents FOR EACH ROW EXECUTE FUNCTION construction_prevent_double_expense_settlement();
CREATE TRIGGER queue_schedule_sms AFTER UPDATE ON deal_payment_schedules FOR EACH ROW EXECUTE FUNCTION tozon_internal.queue_schedule_sms();
CREATE TRIGGER crm_deal_number BEFORE INSERT ON deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_document_number();
CREATE TRIGGER queue_deal_sms AFTER INSERT OR UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.queue_deal_sms();
CREATE TRIGGER construction_audit_expense_settlement AFTER INSERT OR DELETE OR UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION construction_audit_expense_settlement();
CREATE TRIGGER construction_expense_guard BEFORE DELETE OR UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION construction_cash_guard();
CREATE TRIGGER construction_validate_expense_settlement BEFORE INSERT OR UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION construction_validate_expense_settlement();
CREATE TRIGGER crm_expense_number BEFORE INSERT ON expenses FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_document_number();
CREATE TRIGGER construction_payment_guard BEFORE DELETE OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION construction_cash_guard();
CREATE TRIGGER crm_payment_number BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_document_number();
CREATE TRIGGER queue_payment_sms AFTER INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION tozon_internal.queue_payment_sms();
CREATE TRIGGER zz_customer_pko_number BEFORE INSERT OR DELETE OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_customer_pko_number();
CREATE TRIGGER sms_rules_audit AFTER UPDATE ON sms_notification_rules FOR EACH ROW EXECUTE FUNCTION tozon_internal.audit_sms_settings();
CREATE TRIGGER sms_templates_audit AFTER INSERT OR UPDATE ON sms_templates FOR EACH ROW EXECUTE FUNCTION tozon_internal.audit_sms_settings();
CREATE TRIGGER telegram_finance_queue_sheet AFTER UPDATE OF status ON telegram_finance_expense_drafts FOR EACH ROW EXECUTE FUNCTION telegram_finance_queue_sheet();
`;
