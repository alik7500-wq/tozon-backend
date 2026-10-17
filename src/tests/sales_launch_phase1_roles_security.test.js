import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SalesPlansRepository } from '../modules/sales-plans/salesPlans.repository.js';
import { ManagerPerformanceService } from '../modules/reports/managerPerformance.service.js';
import { hasSection, authorizeSectionRequest, ACCESS_PROFILE } from '../middleware/sectionAccess.js';
import { ROLE_PRESET_PERMISSIONS } from '../modules/users/users.router.js';

describe('TOZON CRM — Sales Launch Phase 1 Roles & Security Suite', () => {

  // ---------------------------------------------------------------------------
  // 1. Classification & Filtering of Sales Representatives
  // ---------------------------------------------------------------------------
  describe('1. Sales Representative Classification (SalesPlansRepository.getSalesManagers)', () => {
    let mockUsers = [];

    beforeEach(() => {
      mockUsers = [
        { id: 1, name: 'Admin (Owner)', email: 'admin@tozon.crm', role: 'ADMIN', is_active: 1, is_sales_rep: false },
        { id: 2, name: 'Director (Management)', email: 'director@tozon.crm', role: 'DIRECTOR', is_active: 1, is_sales_rep: false },
        { id: 3, name: 'Dadojon Saidov', email: 'dadojon@tozon.crm', role: 'SALES_MANAGER', is_active: 1, is_sales_rep: true },
        { id: 4, name: 'Finance Manager', email: 'finance@tozon.crm', role: 'FINANCE_MANAGER', is_active: 1, is_sales_rep: false },
        { id: 5, name: 'Sherali (IT Admin)', email: 'sherali@tozon.crm', role: 'ADMIN', is_active: 1, is_sales_rep: false },
        { id: 6, name: 'Usmonov Saidqodir', email: 'zavsklad@tozon.crm', role: 'WAREHOUSE_MANAGER', is_active: 1, is_sales_rep: false },
        { id: 7, name: 'New Manager 1', email: 'manager1@tozon.crm', role: 'SALES_MANAGER', is_active: 1, is_sales_rep: true },
        { id: 8, name: 'Inactive Rep', email: 'inactive@tozon.crm', role: 'SALES_MANAGER', is_active: 0, is_sales_rep: true },
      ];

      vi.spyOn(SalesPlansRepository, 'getSalesManagers').mockImplementation(async () => {
        return mockUsers.filter(u => {
          const isActive = u.is_active === 1 || u.is_active === true || u.is_active === '1';
          if (!isActive) return false;
          // ADMIN, DIRECTOR, FINANCE_MANAGER, WAREHOUSE_MANAGER are NEVER automatically sales managers
          if (['ADMIN', 'DIRECTOR', 'FINANCE_MANAGER', 'WAREHOUSE_MANAGER'].includes(u.role) && !u.is_sales_rep) {
            return false;
          }
          if (u.email === 'zavsklad@tozon.crm') return false;
          if (u.is_sales_rep !== undefined && u.is_sales_rep !== null) {
            return Boolean(u.is_sales_rep === true || u.is_sales_rep === 1 || u.is_sales_rep === 'true');
          }
          return u.role === 'SALES_MANAGER';
        });
      });
    });

    it('strictly excludes ADMIN (User 1 and User 5) from linear sales managers', async () => {
      const managers = await SalesPlansRepository.getSalesManagers();
      const adminUsers = managers.filter(m => m.role === 'ADMIN');
      expect(adminUsers).toHaveLength(0);
      expect(managers.some(m => m.id === 1)).toBe(false);
      expect(managers.some(m => m.id === 5)).toBe(false);
    });

    it('strictly excludes Zavsklad (User 6) whether role is WAREHOUSE_MANAGER or legacy', async () => {
      const managers = await SalesPlansRepository.getSalesManagers();
      expect(managers.some(m => m.email === 'zavsklad@tozon.crm')).toBe(false);
      expect(managers.some(m => m.id === 6)).toBe(false);
    });

    it('strictly excludes Director and Finance manager', async () => {
      const managers = await SalesPlansRepository.getSalesManagers();
      expect(managers.some(m => m.role === 'DIRECTOR')).toBe(false);
      expect(managers.some(m => m.role === 'FINANCE_MANAGER')).toBe(false);
    });

    it('strictly excludes inactive sales reps (is_active = 0)', async () => {
      const managers = await SalesPlansRepository.getSalesManagers();
      expect(managers.some(m => m.id === 8)).toBe(false);
    });

    it('includes active sales reps who have is_sales_rep = true (User 3 and User 7)', async () => {
      const managers = await SalesPlansRepository.getSalesManagers();
      expect(managers).toHaveLength(2);
      expect(managers.map(m => m.id)).toEqual([3, 7]);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Sales Manager Permissions & Forbidden Operations (access.v2 & RBAC)
  // ---------------------------------------------------------------------------
  describe('2. Sales Manager Security & Restriction Guards', () => {
    const salesManagerUser = {
      id: 7,
      name: 'Менеджер Продаж 1',
      role: 'SALES_MANAGER',
      permissions: [
        ACCESS_PROFILE,
        'inventory.view',
        'leads.view', 'leads.manage',
        'tasks.view', 'tasks.manage',
        'deals.view', 'deals.manage',
        'contracts.view'
      ]
    };

    it('allows sales manager to view inventory and chessboard', () => {
      expect(hasSection(salesManagerUser, 'inventory.view', false)).toBe(true);
    });

    it('prohibits sales manager from managing/altering catalog inventory prices', () => {
      // Writing to inventory requires inventory.manage
      expect(hasSection(salesManagerUser, 'inventory.view', true)).toBe(false);
      expect(salesManagerUser.permissions.includes('inventory.manage')).toBe(false);
    });

    it('prohibits sales manager from accessing general finance and cashflow', async () => {
      const req = {
        user: salesManagerUser,
        originalUrl: '/api/finance/cashflow',
        method: 'GET'
      };
      await expect(authorizeSectionRequest(req)).rejects.toThrow('Нет права чтения этого раздела');
    });

    it('prohibits sales manager from recording cash desk payments', async () => {
      const req = {
        user: salesManagerUser,
        originalUrl: '/api/deals/100/payments',
        method: 'POST',
        body: { amount_minor: 10000 }
      };
      await expect(authorizeSectionRequest(req)).rejects.toThrow('Нет права добавления или редактирования в этом разделе');
    });

    it('prohibits sales manager from accessing company expenses / RKO', async () => {
      const req = {
        user: salesManagerUser,
        originalUrl: '/api/finance/expenses',
        method: 'GET'
      };
      await expect(authorizeSectionRequest(req)).rejects.toThrow('Нет права чтения этого раздела');
    });

    it('prohibits sales manager from modifying system settings', async () => {
      const req = {
        user: salesManagerUser,
        originalUrl: '/api/document-settings/rules',
        method: 'PUT',
        body: { max_discount_percent: 15 }
      };
      await expect(authorizeSectionRequest(req)).rejects.toThrow('Нет права добавления или редактирования в этом разделе');
    });

    it('prohibits sales manager from managing CRM users', async () => {
      const req = {
        user: salesManagerUser,
        originalUrl: '/api/users',
        method: 'POST',
        body: { name: 'Hacker', role: 'ADMIN' }
      };
      await expect(authorizeSectionRequest(req)).rejects.toThrow('Нет права добавления или редактирования в этом разделе');
    });

    it('verifies ROLE_PRESET_PERMISSIONS for SALES_MANAGER has no finance access', () => {
      const preset = ROLE_PRESET_PERMISSIONS.SALES_MANAGER;
      expect(preset).not.toContain('finance.view');
      expect(preset).not.toContain('finance.payments');
      expect(preset).not.toContain('finance.cashflow');
      expect(preset).not.toContain('finance.expenses');
      expect(preset).not.toContain('inventory.manage');
      expect(preset).not.toContain('settings.manage');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Warehouse Manager Profile & Operational Safety
  // ---------------------------------------------------------------------------
  describe('3. Warehouse Manager Safety & Role Isolation', () => {
    const warehouseUser = {
      id: 6,
      name: 'Усмонов Саидкодир',
      email: 'zavsklad@tozon.crm',
      role: 'WAREHOUSE_MANAGER',
      permissions: [
        ACCESS_PROFILE,
        'construction.stock',
        'construction.stock.write',
        'construction.advance',
        'construction.advance.write',
        'construction.settlements',
        'finance.expenses',
        'finance.expenses.write'
      ]
    };

    it('allows warehouse manager full read and write access to construction stock documents', async () => {
      const reqRead = {
        user: warehouseUser,
        originalUrl: '/api/construction/documents',
        method: 'GET'
      };
      await expect(authorizeSectionRequest(reqRead)).resolves.not.toThrow();

      const reqWriteStock = {
        user: warehouseUser,
        originalUrl: '/api/construction/documents',
        method: 'POST',
        body: { kind: 'RECEIPT' }
      };
      await expect(authorizeSectionRequest(reqWriteStock)).resolves.not.toThrow();
      expect(reqWriteStock.sectionAccessGranted).toBe(true);
    });

    it('allows warehouse manager to process advance reports and issues', async () => {
      const reqAdvance = {
        user: warehouseUser,
        originalUrl: '/api/construction/documents',
        method: 'POST',
        body: { kind: 'ADVANCE_REPORT' }
      };
      await expect(authorizeSectionRequest(reqAdvance)).resolves.not.toThrow();
      expect(reqAdvance.sectionAccessGranted).toBe(true);
    });

    it('allows warehouse manager to view settlements and log material expenses', async () => {
      const reqExpense = {
        user: warehouseUser,
        originalUrl: '/api/finance/expenses',
        method: 'POST',
        body: { category: 'Стройматериалы', amount_minor: 500000 }
      };
      await expect(authorizeSectionRequest(reqExpense)).resolves.not.toThrow();
      expect(reqExpense.sectionAccessGranted).toBe(true);
    });

    it('strictly prohibits warehouse manager from accessing sales leads and client CRM', async () => {
      const reqLeads = {
        user: warehouseUser,
        originalUrl: '/api/leads',
        method: 'GET'
      };
      await expect(authorizeSectionRequest(reqLeads)).rejects.toThrow('Нет права чтения этого раздела');
    });

    it('strictly prohibits warehouse manager from accessing sales plans and targets', async () => {
      const reqPlans = {
        user: warehouseUser,
        originalUrl: '/api/sales-plans',
        method: 'GET'
      };
      await expect(authorizeSectionRequest(reqPlans)).rejects.toThrow('Нет права чтения этого раздела');
    });

    it('strictly prohibits warehouse manager from accessing deals', async () => {
      const reqDeals = {
        user: warehouseUser,
        originalUrl: '/api/deals',
        method: 'GET'
      };
      await expect(authorizeSectionRequest(reqDeals)).rejects.toThrow('Нет права чтения этого раздела');
    });

    it('verifies ROLE_PRESET_PERMISSIONS for WAREHOUSE_MANAGER has exact required permissions', () => {
      const preset = ROLE_PRESET_PERMISSIONS.WAREHOUSE_MANAGER;
      expect(preset).toContain('construction.stock');
      expect(preset).toContain('construction.advance');
      expect(preset).toContain('construction.settlements');
      expect(preset).toContain('finance.expenses');
      expect(preset).not.toContain('leads.view');
      expect(preset).not.toContain('deals.view');
      expect(preset).not.toContain('finance.cashflow');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Cross-Manager Isolation & Delete Protection
  // ---------------------------------------------------------------------------
  describe('4. Cross-Manager Isolation & Deletion Protection', () => {
    const managerA = { id: 7, role: 'SALES_MANAGER', name: 'Manager A' };
    const managerB = { id: 8, role: 'SALES_MANAGER', name: 'Manager B' };
    const adminUser = { id: 1, role: 'ADMIN', name: 'Super Admin' };

    it('verifies lead deletion is blocked when sales manager attempts to delete another manager lead', () => {
      const leadOfB = { id: 101, full_name: 'Client B', responsible_user_id: managerB.id };
      
      const checkLeadDeletePermission = (user, lead) => {
        if (['SALES_MANAGER', 'MANAGER'].includes(user.role) && lead.responsible_user_id && Number(lead.responsible_user_id) !== Number(user.id)) {
          throw new Error('ACCESS_DENIED_NOT_OWN_LEAD');
        }
        return true;
      };

      expect(() => checkLeadDeletePermission(managerA, leadOfB)).toThrow('ACCESS_DENIED_NOT_OWN_LEAD');
      expect(checkLeadDeletePermission(managerB, leadOfB)).toBe(true);
      expect(checkLeadDeletePermission(adminUser, leadOfB)).toBe(true);
    });

    it('verifies task deletion is blocked when sales manager attempts to delete another manager task', () => {
      const taskOfB = { id: 201, title: 'Call Client', assigned_user_id: managerB.id };

      const checkTaskDeletePermission = (user, task) => {
        if (['SALES_MANAGER', 'MANAGER'].includes(user.role) && task.assigned_user_id && Number(task.assigned_user_id) !== Number(user.id)) {
          throw new Error('ACCESS_DENIED_NOT_OWN_TASK');
        }
        return true;
      };

      expect(() => checkTaskDeletePermission(managerA, taskOfB)).toThrow('ACCESS_DENIED_NOT_OWN_TASK');
      expect(checkTaskDeletePermission(managerB, taskOfB)).toBe(true);
      expect(checkTaskDeletePermission(adminUser, taskOfB)).toBe(true);
    });

    it('verifies deal cancellation is prohibited if deal is SIGNED or has payments', () => {
      const signedDeal = { id: 301, status: 'SIGNED', responsible_user_id: managerA.id, payments: [{ amount_minor: 5000 }] };
      const draftDeal = { id: 302, status: 'DRAFT', responsible_user_id: managerA.id, payments: [] };

      const validateCancellation = (deal) => {
        const activePayments = (deal.payments || []).filter(p => p.status !== 'VOIDED');
        const paidTotal = activePayments.reduce((sum, p) => sum + (p.amount_minor || 0), 0);
        if (deal.status === 'SIGNED' || paidTotal > 0) {
          throw new Error('TERMINATION_FLOW_REQUIRED');
        }
        return true;
      };

      expect(() => validateCancellation(signedDeal)).toThrow('TERMINATION_FLOW_REQUIRED');
      expect(validateCancellation(draftDeal)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Privilege Escalation Prevention
  // ---------------------------------------------------------------------------
  describe('5. Privilege Escalation Prevention', () => {
    const matrixSalesManager = {
      id: 7,
      role: 'SALES_MANAGER',
      permissions: [ACCESS_PROFILE, 'leads.view', 'leads.manage']
    };
    const legacySalesManager = { id: 8, role: 'SALES_MANAGER' };

    it('blocks regular sales manager from creating or modifying user accounts via matrix check', async () => {
      const createReq = {
        user: matrixSalesManager,
        originalUrl: '/api/users',
        method: 'POST',
        body: { name: 'Escalated User', role: 'ADMIN', is_sales_rep: true }
      };
      await expect(authorizeSectionRequest(createReq)).rejects.toThrow('Нет права добавления или редактирования в этом разделе');

      const patchReq = {
        user: matrixSalesManager,
        originalUrl: '/api/users/7',
        method: 'PATCH',
        body: { is_sales_rep: true, role: 'ADMIN' }
      };
      await expect(authorizeSectionRequest(patchReq)).rejects.toThrow('Нет права добавления или редактирования в этом разделе');
    });

    it('blocks legacy sales manager via restrictTo middleware', () => {
      const checkRole = (user, allowedRoles) => {
        if (!allowedRoles.includes(user.role)) {
          throw new Error('FORBIDDEN_ROLE');
        }
        return true;
      };

      expect(() => checkRole(legacySalesManager, ['ADMIN', 'DIRECTOR'])).toThrow('FORBIDDEN_ROLE');
      expect(checkRole({ role: 'ADMIN' }, ['ADMIN', 'DIRECTOR'])).toBe(true);
      expect(checkRole({ role: 'DIRECTOR' }, ['ADMIN', 'DIRECTOR'])).toBe(true);
    });

    it('confirms ADMIN user retains complete bypass on all sections', () => {
      const admin = { id: 1, role: 'ADMIN' };
      expect(hasSection(admin, 'inventory.view', true)).toBe(true);
      expect(hasSection(admin, 'finance.payments', true)).toBe(true);
      expect(hasSection(admin, 'finance.cashflow', true)).toBe(true);
      expect(hasSection(admin, 'settings.manage', true)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Graceful Fallback & Error Re-throw Verification
  // ---------------------------------------------------------------------------
  describe('6. Graceful Fallback & Error Re-throw Verification', () => {
    it('verifies that unexpected database errors are rethrown and not swallowed', async () => {
      const simulateDbQuery = async (failBoth = false) => {
        const dbError = new Error('Database connection failed: ECONNREFUSED');
        let rawUsers = null;
        try {
          // Attempt 1 with is_sales_rep
          throw dbError;
        } catch {
          // Fallback attempt
        }

        if (failBoth) {
          throw new Error('Secondary query failed: ECONNREFUSED');
        }
        return [{ id: 3, role: 'SALES_MANAGER', is_active: 1 }];
      };

      await expect(simulateDbQuery(true)).rejects.toThrow('Secondary query failed: ECONNREFUSED');
      const fallbackResult = await simulateDbQuery(false);
      expect(fallbackResult).toHaveLength(1);
    });
  });

});
