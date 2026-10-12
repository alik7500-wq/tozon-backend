export const can = (user, permission) => user?.role === 'ADMIN' || (user?.permissions || []).includes('*') || (user?.permissions || []).includes(permission);
export const TYPES = ['OPENING_STOCK','RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF','OPENING_SETTLEMENT','ACCRUAL','SETTLEMENT_PAYMENT','OPENING_ADVANCE','ADVANCE_ISSUE','ADVANCE_REPORT','ADVANCE_RETURN','ADVANCE_REIMBURSE'];
export const STOCK_TYPES = TYPES.slice(0,6);
export const permissionFor = type => STOCK_TYPES.includes(type) ? 'construction.stock' : type.includes('ADVANCE') ? 'construction.advance' : 'construction.settlements';
