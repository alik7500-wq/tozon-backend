import { createHash } from 'node:crypto';

// This module has no connection or application imports. The caller owns the
// guarded connection. Each adapter provides query(text, params) and transaction(fn).
export function prepareMigrations(migrations) {
  const seen = new Set();
  return migrations.map(({ name, sql }) => {
    if (!/^[0-9]{4}_[a-z0-9_]+$/.test(name) || seen.has(name)
      || typeof sql !== 'string' || !sql.trim()) {
      throw new Error('INVALID_COMMERCIAL_MIGRATION_MANIFEST');
    }
    seen.add(name);
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function runCommercialMigrations(db, migrations, projectRef) {
  const prepared = prepareMigrations(migrations);
  if (!prepared.length) throw new Error('EMPTY_COMMERCIAL_MIGRATION_MANIFEST');
  return db.transaction(async tx => {
    // Serialize installers; lock is released automatically on commit/rollback.
    await tx.query('SELECT pg_advisory_xact_lock(846922701)');
    await tx.query(`CREATE SCHEMA IF NOT EXISTS tozon_install;
      REVOKE ALL ON SCHEMA tozon_install FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS tozon_install.target (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        project_ref text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tozon_install.migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      REVOKE ALL ON ALL TABLES IN SCHEMA tozon_install FROM PUBLIC;`);
    const targets = await tx.query('SELECT project_ref FROM tozon_install.target');
    if (targets.length && targets[0].project_ref !== projectRef) {
      throw new Error('COMMERCIAL_INSTALLATION_TARGET_MISMATCH');
    }
    if (!targets.length) {
      const existing = await tx.query(`SELECT n.nspname, c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`);
      if (existing.length) throw new Error('COMMERCIAL_INSTALL_REQUIRES_EMPTY_PUBLIC_SCHEMA');
      await tx.query('INSERT INTO tozon_install.target(project_ref) VALUES ($1)', [projectRef]);
    }
    const applied = await tx.query('SELECT name, checksum FROM tozon_install.migrations ORDER BY name');
    const byName = new Map(prepared.map(m => [m.name, m]));
    for (const row of applied) {
      if (!byName.has(row.name) || byName.get(row.name).checksum !== row.checksum) {
        throw new Error('COMMERCIAL_MIGRATION_HISTORY_MISMATCH');
      }
    }
    const done = new Set(applied.map(m => m.name));
    const last = applied.at(-1)?.name;
    const pending = prepared.filter(m => !done.has(m.name));
    if (last && pending.some(m => m.name < last)) {
      throw new Error('COMMERCIAL_MIGRATION_ORDER_MISMATCH');
    }
    for (const migration of pending) {
      await tx.query(migration.sql);
      await tx.query('INSERT INTO tozon_install.migrations(name, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum]);
    }
    return { applied: pending.map(m => m.name), skipped: [...done] };
  });
}
