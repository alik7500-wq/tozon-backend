export function isCustomerPko(p) {
  return p.deal_id != null && (p.operation_type ?? 'STANDARD') === 'STANDARD'
    && (p.settlement_method ?? 'CASH') === 'CASH' && !p.transfer_id && !p.conversion_id;
}

export function isVoidedPko(p) {
  return ['VOIDED', 'CANCELLED', 'REVERSED'].includes(p.status) || Boolean(p.voidedAt || p.voided_at);
}
