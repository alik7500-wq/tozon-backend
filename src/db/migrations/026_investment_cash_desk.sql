-- Migration: 026_investment_cash_desk.sql
-- Description: Создание отдельной инвестиционной кассы TOZON PLAZA и статьи ДДС "Инвестиции партнёров"

BEGIN;

-- 1. Добавление кассы "Инвестиционная касса TOZON PLAZA" в dictionaries
INSERT INTO public.dictionaries (type, name, code, color, icon, sort_order, is_active, is_system)
SELECT 'CASH_DESK', 'Инвестиционная касса TOZON PLAZA', 'TOZON_PLAZA_INVESTMENT', '#8b5cf6', '📈', 10, true, false
WHERE NOT EXISTS (
  SELECT 1 FROM public.dictionaries WHERE code = 'TOZON_PLAZA_INVESTMENT' AND type = 'CASH_DESK'
);

-- 2. Добавление статьи ДДС "Инвестиции партнёров" в dictionaries
INSERT INTO public.dictionaries (type, name, code, color, icon, sort_order, is_active, is_system)
SELECT 'INCOME_CATEGORY', 'Инвестиции партнёров', 'PARTNER_INVESTMENT', '#8b5cf6', '💼', 7, true, false
WHERE NOT EXISTS (
  SELECT 1 FROM public.dictionaries WHERE code = 'PARTNER_INVESTMENT' AND type = 'INCOME_CATEGORY'
);

-- 3. Расширение таблицы payments дополнительными полями (если их нет)
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS project_id INT REFERENCES public.projects(id);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS category VARCHAR(100);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS basis TEXT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS purpose TEXT;

COMMIT;
