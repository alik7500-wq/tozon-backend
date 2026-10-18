-- PRE-050 BACKUP RESTORATION SCRIPT
-- Timestamp: 2026-10-18T11:26:58.526Z
-- Total notes: 3
BEGIN;

INSERT INTO public.lead_notes (id, lead_id, author_user_id, body, created_at, updated_at) VALUES (6, 13, 1, '💰 Ждет одобрения бюджета', '2026-09-22T17:22:19.882Z', 'undefined') ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body;
INSERT INTO public.lead_notes (id, lead_id, author_user_id, body, created_at, updated_at) VALUES (7, 56, 1, '❌ Отказ: дорого', '2026-10-13T21:21:23.272Z', 'undefined') ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body;
INSERT INTO public.lead_notes (id, lead_id, author_user_id, body, created_at, updated_at) VALUES (8, 10, 1, '[UNIT_INTEREST] {"unit_id":90,"priority":"HIGH","comment":"Тест подбора для Акмала Каримова: 2-комн на 3 этаже","next_contact_date":"2026-10-25","created_at":"2026-10-18T09:14:34.502Z","created_by_user_id":1}', '2026-10-18T09:14:34.912Z', 'undefined') ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body;
COMMIT;