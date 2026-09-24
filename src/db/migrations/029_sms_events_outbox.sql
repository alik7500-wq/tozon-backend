-- Migration 029: SMS Center V1.5B Outbox Core Architecture (sms_events)
-- DO NOT APPLY TO PRODUCTION UNTIL RELEASE GATE APPROVAL

-- 1. Create sms_events table
CREATE TABLE IF NOT EXISTS public.sms_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    idempotency_key VARCHAR(150) NOT NULL CONSTRAINT uq_sms_events_idempotency_key UNIQUE,
    mode VARCHAR(20) NOT NULL DEFAULT 'CONFIRM' CONSTRAINT chk_sms_events_mode CHECK (mode IN ('CONFIRM', 'AUTO', 'OFF')),
    status VARCHAR(30) NOT NULL DEFAULT 'AWAITING_CONFIRMATION' CONSTRAINT chk_sms_events_status CHECK (status IN ('AWAITING_CONFIRMATION', 'PROCESSING', 'SENT', 'CANCELLED', 'FAILED', 'DELIVERY_UNKNOWN')),
    
    -- Context Foreign Keys matching exact parent column UDTs
    client_id INTEGER REFERENCES public.leads(id) ON DELETE SET NULL,
    deal_id INTEGER REFERENCES public.deals(id) ON DELETE SET NULL,
    payment_id INTEGER REFERENCES public.payments(id) ON DELETE SET NULL,
    schedule_id INTEGER REFERENCES public.deal_payment_schedules(id) ON DELETE SET NULL,
    task_id INTEGER REFERENCES public.tasks(id) ON DELETE SET NULL,
    
    template_code VARCHAR(50) NOT NULL,
    payload_json JSONB DEFAULT '{}'::jsonb, -- snapshot for audit context only (payload is NOT source of truth)
    
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    confirmed_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    confirmed_at TIMESTAMPTZ,
    cancelled_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    cancelled_at TIMESTAMPTZ,
    cancel_reason TEXT,
    
    failure_code VARCHAR(50),
    failure_message TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Add event_id FK to sms_messages (1 event -> N delivery attempt messages)
ALTER TABLE public.sms_messages 
ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES public.sms_events(id) ON DELETE SET NULL;

-- 3. Indexes for Outbox Queue & Context lookup performance
CREATE INDEX IF NOT EXISTS idx_sms_events_status_available ON public.sms_events(status, available_at);
CREATE INDEX IF NOT EXISTS idx_sms_events_client_id ON public.sms_events(client_id);
CREATE INDEX IF NOT EXISTS idx_sms_events_deal_id ON public.sms_events(deal_id);
CREATE INDEX IF NOT EXISTS idx_sms_events_payment_id ON public.sms_events(payment_id);
CREATE INDEX IF NOT EXISTS idx_sms_events_schedule_id ON public.sms_events(schedule_id);
CREATE INDEX IF NOT EXISTS idx_sms_events_task_id ON public.sms_events(task_id);
CREATE INDEX IF NOT EXISTS idx_sms_events_created_at ON public.sms_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_messages_event_id ON public.sms_messages(event_id);

-- 4. Enable Row-Level Security (RLS)
ALTER TABLE public.sms_events ENABLE ROW LEVEL SECURITY;

-- Service role access policy for backend operation
DROP POLICY IF EXISTS sms_events_service_role_all ON public.sms_events;
CREATE POLICY sms_events_service_role_all ON public.sms_events 
    FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

-- Revoke all direct anon & authenticated table access (Frontend accesses outbox strictly via Express REST API)
REVOKE ALL ON public.sms_events FROM anon, authenticated, public;

-- Comment for metadata
COMMENT ON TABLE public.sms_events IS 'SMS Center V1.5B Outbox events queue for event-driven SMS workflow';
