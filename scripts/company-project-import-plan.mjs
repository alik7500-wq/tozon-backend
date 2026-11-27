// Offline planning only. This module has no database client or write operation.
export function buildImportPlan(source, target) {
  if (!source?.snapshot_at || !source?.counts || !Array.isArray(source.users) ||
      !Array.isArray(source.complexes) || !Array.isArray(target?.users) ||
      !Array.isArray(target?.complexes)) throw new Error('INCOMPLETE_INVENTORY');
  const duplicate = rows => new Set(rows.map(r => String(r.id))).size !== rows.length;
  if ([source.users, source.complexes, target.users, target.complexes].some(duplicate)) {
    throw new Error('DUPLICATE_ID');
  }
  const entity = (row, existing) => ({
    source_id: row.id,
    target_id: null,
    action: 'ALLOCATE_NEW_ID_WITH_SOURCE_MAP',
    numeric_id_collision: existing.some(t => String(t.id) === String(row.id)),
  });
  const crossScope = source.cross_scope_cash || [];
  return {
    format_version: 1,
    mode: 'OFFLINE_PREFLIGHT_ONLY',
    snapshot_at: source.snapshot_at,
    source_counts: source.counts,
    execution_ready: false,
    users: source.users.map(u => ({
      ...entity(u, target.users), source_role: u.role,
      source_active: u.is_active === 1 || u.is_active === true,
      target_enabled: false, copy_credentials: false, copy_global_permissions: false,
      access_action: 'TRANSLATE_EXPLICIT_PROJECT_AND_CASH_GRANTS',
    })),
    complexes: source.complexes.map(p => ({
      ...entity(p, target.complexes), source_code: p.code,
      accounting_scope: p.id === 3 ? 'AB' : p.id === 4 ? 'VG' : 'UNRESOLVED',
      company_project_target_id: null,
      preserve_demo_history: true,
    })),
    cash_desks: (source.cash_desks || []).map(d => ({
      source_id: d.id, target_id: null, source_code: d.code,
      action: 'ALLOCATE_NEW_ID_WITH_SOURCE_MAP',
      accounting_scope: d.code === 'TOZON_PLAZA_2_CASH' ? 'VG' :
        source.complexes.every(p => [3, 4].includes(p.id)) ? 'AB' : 'UNRESOLVED',
      scope_basis: 'LEGACY_ACCOUNTING_SCOPE_RULE_REQUIRES_RECONCILIATION',
    })),
    warehouses: (source.warehouses || []).map(w => ({
      source_id: w.id, target_id: null, source_responsible_user_id: w.responsible_user_id,
      source_document_scopes: (source.stock_links || []).filter(l => l.warehouse_id === w.id),
      action: 'MAP_WAREHOUSE_RESPONSIBLE_AND_DOCUMENT_PROJECTS',
    })),
    financial_policy: {
      preserve_all_statuses: true, count_voided_in_balances: false,
      preserve_original_dates_amounts_currencies_rates: true,
      preserve_transfer_and_conversion_groups: true,
      infer_opening_balance_from_raw_sums: false,
      grant_access_from_record_authorship: false,
    },
    cross_scope_cash: crossScope,
    active_cross_scope_count: crossScope.filter(r => r.status === 'ACTIVE').reduce((n, r) => n + r.count, 0),
    unmapped_deal_count: source.unlinked_deals,
    remaining_gates: [
      'EXPORT_FULL_DEPENDENCY_GRAPH_AND_VERIFY_RECORD_HASHES',
      'REMAP_ALL_FOREIGN_KEYS_IN_A_SEPARATE_STAGING_DATASET',
      'RECONCILE_TRANSFER_CONVERSION_AND_BARTER_SEMANTICS',
      'VERIFY_PROJECT_AND_PER_CASH_DESK_ACCESS_WITHOUT_BROADENING',
      'VERIFY_FROZEN_SIGNERS_AND_TEMPLATE_SCOPES',
      'APPROVE_BACKED_UP_CUTOVER_WITH_CURRENT_SNAPSHOT',
    ],
  };
}
