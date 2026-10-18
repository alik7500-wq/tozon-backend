import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LeadsRepository } from '../modules/leads/leads.repository.js';
import { AppError } from '../shared/errors/errorHandler.js';

vi.mock('../db/connection.js', () => ({
  getServiceDB: vi.fn(),
  getDB: vi.fn(),
  assertSafeTestDatabase: vi.fn(() => true)
}));

import { getServiceDB, getDB } from '../db/connection.js';

describe('TOZON CRM — Phase 3.6 Sales Control Hotfix Test Suite', () => {
  let mockSupabase;
  let mockLeadsData = [];
  let shouldFailQuery = false;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadsData = [];
    shouldFailQuery = false;

    mockSupabase = {
      from: vi.fn(() => {
        let isManagerFilterApplied = false;
        let managerFilterId = null;

        const q = {
          select: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          eq: vi.fn((field, val) => {
            if (field === 'responsible_user_id') {
              isManagerFilterApplied = true;
              managerFilterId = val;
            }
            return q;
          }),
          then(resolve, reject) {
            if (shouldFailQuery) {
              const err = new Error('permission denied for table tasks');
              err.code = '42501';
              return Promise.resolve({ data: null, error: err }).then(resolve, reject);
            }
            let data = [...mockLeadsData];
            if (isManagerFilterApplied) {
              data = data.filter((l) => l.responsible_user_id === managerFilterId);
            }
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          }
        };
        return q;
      })
    };

    getServiceDB.mockReturnValue(mockSupabase);
    getDB.mockReturnValue(mockSupabase);
  });

  it('1. verifies getSecureDB (service_role) is called for getSlaControlData', async () => {
    const adminUser = { id: 1, role: 'ADMIN', name: 'Admin User' };
    mockLeadsData = [
      {
        id: 101,
        full_name: 'Активный Лид',
        status: 'NEW',
        responsible_user_id: 1,
        created_at: new Date().toISOString(),
        tasks: []
      }
    ];

    const res = await LeadsRepository.getSlaControlData({}, adminUser);
    expect(getServiceDB).toHaveBeenCalled();
    expect(res.state).toBe('SUCCESS');
    expect(res.isAvailable).toBe(true);
    expect(res.leads).toHaveLength(1);
  });

  it('2. ADMIN and DIRECTOR have full team access to SLA control data', async () => {
    const adminUser = { id: 1, role: 'ADMIN', name: 'Admin User' };
    const directorUser = { id: 2, role: 'DIRECTOR', name: 'Director User' };

    mockLeadsData = [
      { id: 101, full_name: 'Лид 1', status: 'NEW', responsible_user_id: 3, created_at: new Date().toISOString(), tasks: [] },
      { id: 102, full_name: 'Лид 2', status: 'NEW', responsible_user_id: 4, created_at: new Date().toISOString(), tasks: [] }
    ];

    const adminRes = await LeadsRepository.getSlaControlData({}, adminUser);
    expect(adminRes.leads).toHaveLength(2);
    expect(adminRes.summary.totalActive).toBe(2);

    const directorRes = await LeadsRepository.getSlaControlData({}, directorUser);
    expect(directorRes.leads).toHaveLength(2);
    expect(directorRes.summary.totalActive).toBe(2);
  });

  it('3. SALES_MANAGER is strictly restricted to own assigned leads', async () => {
    const salesManager = { id: 3, role: 'SALES_MANAGER', name: 'Менеджер 1' };

    mockLeadsData = [
      { id: 101, full_name: 'Мой Лид', status: 'IN_PROGRESS', responsible_user_id: 3, created_at: new Date().toISOString(), tasks: [] },
      { id: 102, full_name: 'Чужой Лид', status: 'IN_PROGRESS', responsible_user_id: 4, created_at: new Date().toISOString(), tasks: [] }
    ];

    const res = await LeadsRepository.getSlaControlData({}, salesManager);
    expect(res.leads).toHaveLength(1);
    expect(res.leads[0].id).toBe(101);
    expect(res.leads[0].responsible_user_id).toBe(3);
  });

  it('4. FINANCE_MANAGER is denied access with 403 Forbidden', async () => {
    const financeUser = { id: 5, role: 'FINANCE_MANAGER', name: 'Бухгалтер' };

    await expect(
      LeadsRepository.getSlaControlData({}, financeUser)
    ).rejects.toThrow('Доступ к контролю лидов разрешен только менеджерам по продажам и руководству');
  });

  it('5. returns structured DATA_UNAVAILABLE state with zero false numbers when query fails', async () => {
    const adminUser = { id: 1, role: 'ADMIN', name: 'Admin User' };
    shouldFailQuery = true;

    const res = await LeadsRepository.getSlaControlData({}, adminUser);
    expect(res.state).toBe('DATA_UNAVAILABLE');
    expect(res.isAvailable).toBe(false);
    expect(res.message).toBe('Данные контроля обработки лидов временно недоступны');
    expect(res.leads).toHaveLength(0);
    expect(res.summary).toBeDefined();
    expect(res.summary.totalActive).toBe(0);
    expect(res.summary.unassignedCount).toBe(0);
    expect(res.summary.contactOverdueCount).toBe(0);
    expect(res.summary.contactWarningCount).toBe(0);
    expect(res.summary.overdueTasksCount).toBe(0);
    expect(res.summary.stagnantCount).toBe(0);
    expect(res.summary.onTrackCount).toBe(0);
  });

  it('6. calculates all 6 SLA KPI metrics accurately on success', async () => {
    const adminUser = { id: 1, role: 'ADMIN', name: 'Admin User' };
    const now = Date.now();
    const threeDaysAgo = new Date(now - 72 * 3600 * 1000).toISOString();
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(now - 86400000).toISOString().split('T')[0];

    mockLeadsData = [
      // 1. Unassigned
      {
        id: 201,
        full_name: 'Лид в пуле',
        status: 'NEW',
        responsible_user_id: null,
        created_at: threeDaysAgo,
        tasks: []
      },
      // 2. Overdue task
      {
        id: 202,
        full_name: 'Лид с просроченной задачей',
        status: 'IN_PROGRESS',
        responsible_user_id: 1,
        created_at: threeDaysAgo,
        updated_at: new Date().toISOString(),
        tasks: [{ id: 1, status: 'OPEN', due_date: yesterday, type: 'CALL' }]
      },
      // 3. Stagnant (>48h without task)
      {
        id: 203,
        full_name: 'Зависший лид',
        status: 'IN_PROGRESS',
        responsible_user_id: 1,
        created_at: threeDaysAgo,
        updated_at: threeDaysAgo,
        tasks: []
      }
    ];

    const res = await LeadsRepository.getSlaControlData({}, adminUser);
    expect(res.state).toBe('SUCCESS');
    expect(res.summary.unassignedCount).toBe(1);
    expect(res.summary.overdueTasksCount).toBe(1);
    expect(res.summary.stagnantCount).toBe(1);
  });
});
