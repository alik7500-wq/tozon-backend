-- PROPOSAL ONLY. DO NOT APPLY TO PRODUCTION WITHOUT DATA AUDIT.
-- Prevent concurrent API calls from creating duplicate panorama names or file paths.
-- Existing duplicate records must be reconciled before these indexes can be installed.
-- Run the read-only preflight queries first:
SELECT tour_id, name, count(*) AS duplicates, array_agg(id ORDER BY id) AS panorama_ids
FROM public.panorama_360
GROUP BY tour_id, name HAVING count(*) > 1;

SELECT tour_id, storage_path, count(*) AS duplicates, array_agg(id ORDER BY id) AS panorama_ids
FROM public.panorama_360
WHERE storage_path IS NOT NULL
GROUP BY tour_id, storage_path HAVING count(*) > 1;

-- Proposed DDL (intentionally commented out):
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS panorama_360_tour_name_unique
--   ON public.panorama_360 (tour_id, name);
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS panorama_360_tour_storage_path_unique
--   ON public.panorama_360 (tour_id, storage_path)
--   WHERE storage_path IS NOT NULL;
-- Note: uniqueness applies to all tours, including existing published tours.
-- Confirm historical data and application naming conventions before rollout.
