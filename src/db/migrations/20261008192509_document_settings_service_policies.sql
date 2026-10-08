-- These tables are server-only. Explicit policies document the intended row access;
-- anon and authenticated retain no table privileges and no row policies.
CREATE POLICY crm_document_settings_service ON public.crm_document_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY crm_document_history_service ON public.crm_document_settings_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY crm_document_templates_service ON public.crm_document_templates
  FOR ALL TO service_role USING (true) WITH CHECK (true);
