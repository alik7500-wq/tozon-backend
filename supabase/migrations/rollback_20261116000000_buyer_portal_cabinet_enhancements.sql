-- Rollback script for 20261116000000_buyer_portal_cabinet_enhancements.sql
drop function if exists public.buyer_portal_construction(bigint, integer);
