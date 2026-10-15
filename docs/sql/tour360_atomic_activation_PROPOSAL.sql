-- DESIGN ONLY — DO NOT APPLY. Intentionally no executable activation RPC.
-- Earlier proposal was unsafe: a service-role caller could set a journal row
-- to ACTIVATING without durable SHA-256 attestation and activate a tour.
-- Required before writing an executable migration:
-- 1. Private immutable draft bucket, narrow storage.objects grants/policies.
-- 2. Service-only journal and atomic, immutable per-file checksum attestations.
-- 3. A transaction that validates manifest file set == attested file set,
--    tour/project IDs, fresh verification timestamp and current tour revision.
-- 4. A trusted backend path for entering ACTIVATING, inaccessible to clients.
-- 5. Crash recovery, concurrency, idempotency and storage-policy integration tests.
-- 6. Review actual PostgreSQL schema (projects.id and tours_360.id are integer).
-- This placeholder deliberately fails if executed, to prevent accidental rollout.
DO $$ BEGIN
  RAISE EXCEPTION 'TOUR360_ACTIVATION_NOT_RELEASE_READY';
END $$;
