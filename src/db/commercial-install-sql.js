import { assertCommercialInstallTarget } from './commercial-install-guard.js';
import { prepareMigrations } from './commercial-migration-runner.js';

const literal = value => `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;

// SQL-editor transport for the same packaged manifest and ledger as the driver.
// The operator must independently select the matching isolated project in the UI.
// Connection credentials are validated but never included in the output.
export function renderCommercialInstallSql(migrations, env) {
  const { projectRef } = assertCommercialInstallTarget(env);
  const prepared = prepareMigrations(migrations);
  if (!prepared.length) throw new Error('EMPTY_COMMERCIAL_MIGRATION_MANIFEST');
  const manifest = literal(JSON.stringify(prepared));
  const body = `
DECLARE
 manifest jsonb := ${manifest}::jsonb;
 item jsonb;
 history record;
 last_name text;
BEGIN
 PERFORM pg_advisory_xact_lock(846922701);
 CREATE SCHEMA IF NOT EXISTS tozon_install;
 REVOKE ALL ON SCHEMA tozon_install FROM PUBLIC, anon, authenticated;
 CREATE TABLE IF NOT EXISTS tozon_install.target (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), project_ref text NOT NULL
 );
 CREATE TABLE IF NOT EXISTS tozon_install.migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
 );
 REVOKE ALL ON ALL TABLES IN SCHEMA tozon_install FROM PUBLIC, anon, authenticated;
 IF EXISTS (SELECT 1 FROM tozon_install.target WHERE project_ref <> ${literal(projectRef)}) THEN
  RAISE EXCEPTION 'COMMERCIAL_INSTALLATION_TARGET_MISMATCH';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM tozon_install.target) THEN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')) THEN
   RAISE EXCEPTION 'COMMERCIAL_INSTALL_REQUIRES_EMPTY_PUBLIC_SCHEMA';
  END IF;
  INSERT INTO tozon_install.target(project_ref) VALUES (${literal(projectRef)});
 END IF;
 FOR history IN SELECT name, checksum FROM tozon_install.migrations LOOP
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(manifest) m
   WHERE m->>'name'=history.name AND m->>'checksum'=history.checksum) THEN
   RAISE EXCEPTION 'COMMERCIAL_MIGRATION_HISTORY_MISMATCH';
  END IF;
 END LOOP;
 SELECT max(name) INTO last_name FROM tozon_install.migrations;
 FOR item IN SELECT value FROM jsonb_array_elements(manifest) LOOP
  IF NOT EXISTS (SELECT 1 FROM tozon_install.migrations WHERE name=item->>'name') THEN
   IF last_name IS NOT NULL AND item->>'name' < last_name THEN
    RAISE EXCEPTION 'COMMERCIAL_MIGRATION_ORDER_MISMATCH';
   END IF;
   EXECUTE item->>'sql';
   INSERT INTO tozon_install.migrations(name,checksum) VALUES (item->>'name',item->>'checksum');
  END IF;
 END LOOP;
END;
`;
  // Dollar-quote delimiter cannot collide with a packaged SQL body.
  let delimiter = '$commercial_install$';
  while (body.includes(delimiter)) delimiter = delimiter.slice(0, -1) + '_$';
  return `-- Target project: ${projectRef}. Isolated test database only.\nDO ${delimiter}${body}${delimiter};\n`;
}
