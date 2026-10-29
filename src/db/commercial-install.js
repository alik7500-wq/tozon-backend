import { pathToFileURL } from 'node:url';
import { assertCommercialInstallTarget } from './commercial-install-guard.js';
import { commercialMigrations, commercialCoreMigrations, commercialSchemaMigrations } from './commercial-install-manifest.js';
import { prepareMigrations, runCommercialMigrations } from './commercial-migration-runner.js';
import { renderCommercialInstallSql } from './commercial-install-sql.js';

export async function commercialInstall(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 1 || !['--plan', '--apply-bootstrap', '--plan-core', '--apply-core', '--export-core-sql', '--plan-schema', '--apply-schema', '--export-schema-sql'].includes(args[0])) {
    throw new Error('USE_COMMERCIAL_INSTALL_PLAN_OR_APPLY_BOOTSTRAP');
  }
  const target = assertCommercialInstallTarget(env);
  if (args[0] === '--export-core-sql') return renderCommercialInstallSql(commercialCoreMigrations, env);
  if (args[0] === '--export-schema-sql') return renderCommercialInstallSql(commercialSchemaMigrations, env);
  const core = args[0].endsWith('-core');
  const schema = args[0].endsWith('-schema');
  const migrations = schema ? commercialSchemaMigrations : core ? commercialCoreMigrations : commercialMigrations;
  const plan = {
    projectRef: target.projectRef,
    scope: schema ? 'backend_schema_preview' : core ? 'core_schema_preview' : 'installer_bootstrap_only',
    crmReady: false,
    migrations: prepareMigrations(migrations).map(({ name, checksum }) => ({ name, checksum })),
  };
  if (args[0].startsWith('--plan')) return plan; // No driver import or connection.
  const { default: postgres } = await import('postgres');
  const sql = postgres(target.databaseUrl, {
    max: 1, prepare: false, ssl: { rejectUnauthorized: true },
    connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: 'tozon-commercial-bootstrap', statement_timeout: 30000, lock_timeout: 5000 },
    onnotice: () => {},
  });
  const adapt = client => ({ query: (text, params = []) => client.unsafe(text, params) });
  try {
    const result = await runCommercialMigrations({
      transaction: fn => sql.begin(tx => fn(adapt(tx))),
    }, migrations, target.projectRef);
    return { ...plan, ...result };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  commercialInstall().then(result => console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))).catch(error => {
    // Driver errors may contain credentials or SQL literals; never log them.
    const safeCode = /^(COMMERCIAL_|INVALID_|UNSUPPORTED_|DATABASE_|PRODUCTION_|USE_|EMPTY_)[A-Z_]+$/.test(error.message)
      ? error.message : 'COMMERCIAL_INSTALL_FAILED';
    console.error(safeCode);
    process.exitCode = 1;
  });
}
