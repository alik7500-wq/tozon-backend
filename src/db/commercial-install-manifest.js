import { commercialCoreSchema } from './commercial-core-schema.js';
import { commercialExtendedSchema, commercialExtendedFunctions } from './commercial-extended-schema.js';

// Do not import historical CRM SQL:
// it mixes SQLite definitions, PostgreSQL changes and production data repairs.
export const commercialMigrations = [{
  name: '0001_bootstrap',
  sql: `CREATE TABLE tozon_install.bootstrap (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    baseline_status text NOT NULL CHECK (baseline_status = 'pending_schema_review')
  );
  REVOKE ALL ON tozon_install.bootstrap FROM PUBLIC;
  INSERT INTO tozon_install.bootstrap(baseline_status) VALUES ('pending_schema_review');`,
}];

// A separate, explicit preview opt-in. The bootstrap manifest stays immutable.
export const commercialCoreMigrations = [
  ...commercialMigrations,
  { name: '0002_core_preview', sql: commercialCoreSchema },
];

export const commercialSchemaMigrations = [
  ...commercialCoreMigrations,
  { name: '0003_schema_reconciliation', sql: commercialExtendedSchema },
  { name: '0004_backend_functions', sql: commercialExtendedFunctions },
];
