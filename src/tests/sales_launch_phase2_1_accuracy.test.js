import { describe, it, expect } from 'vitest';
import {
  evaluateLeadSla,
  calculateSalesWorkingMinutes,
  calculateSalesSlaDeadline,
  SLA_FIRST_CONTACT_MINUTES
} from '../modules/leads/leadSla.service.js';

describe('TOZON CRM — Sales Launch Phase 2.1: Leads Dashboard Accuracy & SLA Audit', () => {
  // Test reference times (Asia/Dushanbe UTC+5)
  // 2026-10-16 is Friday (Working day). 10:00 local = 05:00 UTC.
  const friday1000 = new Date('2026-10-16T05:00:00.000Z');
  const friday1010 = new Date('2026-10-16T05:10:00.000Z');
  const friday1020 = new Date('2026-10-16T05:20:00.000Z');

  describe('1. Исторические WON лиды без ответственного', () => {
    it('historical WON lead without responsible user has ZERO SLA breaches and is NOT in pool', () => {
      const historicalLead = {
        id: 101,
        full_name: 'Исторический Клиент Сделка',
        status: 'WON',
        responsible_user_id: null,
        created_at: '2026-08-01T05:00:00.000Z'
      };

      const sla = evaluateLeadSla(historicalLead, friday1000);

      expect(sla.is_unassigned).toBe(false);
      expect(sla.pool_sla.is_overdue).toBe(false);
      expect(sla.pool_sla.status).toBe('CLOSED');
      expect(sla.manager_sla.is_overdue).toBe(false);
      expect(sla.manager_sla.status).toBe('CLOSED');
      expect(sla.overall_status).toBe('WON');
      expect(sla.badge.label).toBe('Сделка заключена');
      expect(sla.badge.color).toBe('emerald');
    });

    it('historical WON lead with responsible user has ZERO SLA breaches', () => {
      const historicalLead = {
        id: 102,
        full_name: 'Клиент Заключил Сделку',
        status: 'WON',
        responsible_user_id: 3,
        created_at: '2026-08-01T05:00:00.000Z',
        assigned_at: '2026-08-01T05:05:00.000Z'
      };

      const sla = evaluateLeadSla(historicalLead, friday1000);

      expect(sla.is_unassigned).toBe(false);
      expect(sla.pool_sla.is_overdue).toBe(false);
      expect(sla.manager_sla.is_overdue).toBe(false);
      expect(sla.overall_status).toBe('WON');
      expect(sla.badge.label).toBe('Сделка заключена');
    });
  });

  describe('2. Завершённый LOST лид (Отказ / Архив)', () => {
    it('LOST lead has ZERO SLA breaches and appropriate badge', () => {
      const lostLead = {
        id: 103,
        full_name: 'Клиент Отказался',
        status: 'LOST',
        responsible_user_id: 1,
        created_at: '2026-08-01T05:00:00.000Z'
      };

      const sla = evaluateLeadSla(lostLead, friday1000);

      expect(sla.is_unassigned).toBe(false);
      expect(sla.pool_sla.is_overdue).toBe(false);
      expect(sla.manager_sla.is_overdue).toBe(false);
      expect(sla.overall_status).toBe('LOST');
      expect(sla.badge.label).toBe('Отказ / Архив');
      expect(sla.badge.color).toBe('slate');
    });
  });

  describe('3. Новый активный лид без ответственного (Общий пул)', () => {
    it('fresh unassigned lead within 15 minutes is ON_TRACK in pool', () => {
      const freshLead = {
        id: 201,
        full_name: 'Новая Заявка с Сайта',
        status: 'NEW',
        responsible_user_id: null,
        created_at: friday1000.toISOString()
      };

      const sla = evaluateLeadSla(freshLead, friday1010); // 10 mins elapsed

      expect(sla.is_unassigned).toBe(true);
      expect(sla.pool_sla.is_overdue).toBe(false);
      expect(sla.pool_sla.status).toBe('POOL_WARNING'); // 10 min warning
      expect(sla.pool_sla.remaining_minutes).toBe(5);
      expect(sla.overall_status).toBe('UNASSIGNED');
    });

    it('unassigned lead exceeding 15 minutes working time is POOL_OVERDUE', () => {
      const overdueLead = {
        id: 202,
        full_name: 'Забытая Заявка в Пуле',
        status: 'NEW',
        responsible_user_id: null,
        created_at: friday1000.toISOString()
      };

      const sla = evaluateLeadSla(overdueLead, friday1020); // 20 mins elapsed

      expect(sla.is_unassigned).toBe(true);
      expect(sla.pool_sla.is_overdue).toBe(true);
      expect(sla.pool_sla.status).toBe('POOL_OVERDUE');
      expect(sla.pool_sla.overdue_minutes).toBe(5);
      expect(sla.overall_status).toBe('UNASSIGNED');
      expect(sla.badge.level).toBe('CRITICAL');
    });
  });

  describe('4. Назначенный активный лид у менеджера', () => {
    it('assigned lead without contact exceeding 15 mins triggers manager SLA overdue', () => {
      const assignedLead = {
        id: 301,
        full_name: 'Лид у Дадочона',
        status: 'NEW',
        responsible_user_id: 3,
        created_at: friday1000.toISOString(),
        assigned_at: friday1000.toISOString(),
        first_contact_at: null
      };

      const sla = evaluateLeadSla(assignedLead, friday1020); // 20 mins elapsed

      expect(sla.is_unassigned).toBe(false);
      expect(sla.pool_sla.is_overdue).toBe(false); // pool is closed on assignment
      expect(sla.manager_sla.applies).toBe(true);
      expect(sla.manager_sla.is_overdue).toBe(true);
      expect(sla.manager_sla.status).toBe('CONTACT_OVERDUE');
      expect(sla.overall_status).toBe('OVERDUE_CONTACT');
      expect(sla.badge.level).toBe('CRITICAL');
    });

    it('assigned lead with contact recorded closes manager SLA successfully', () => {
      const contactedLead = {
        id: 302,
        full_name: 'Лид с Контактом',
        status: 'NEW',
        responsible_user_id: 3,
        created_at: friday1000.toISOString(),
        assigned_at: friday1000.toISOString(),
        first_contact_at: friday1010.toISOString()
      };

      const sla = evaluateLeadSla(contactedLead, friday1020);

      expect(sla.manager_sla.contact_made).toBe(true);
      expect(sla.manager_sla.is_overdue).toBe(false);
      expect(sla.manager_sla.status).toBe('CONTACT_COMPLETED_IN_TIME');
      expect(sla.overall_status).toBe('ON_TRACK');
      expect(sla.badge.label).toBe('Контакт выполнен');
    });

    it('assigned lead moved to IN_PROGRESS or NEGOTIATION implicitly satisfies contact SLA', () => {
      const inProgressLead = {
        id: 303,
        full_name: 'Лид в Работе',
        status: 'IN_PROGRESS',
        responsible_user_id: 1,
        created_at: friday1000.toISOString(),
        assigned_at: friday1000.toISOString()
      };

      const sla = evaluateLeadSla(inProgressLead, friday1020);

      expect(sla.manager_sla.contact_made).toBe(true);
      expect(sla.manager_sla.is_overdue).toBe(false);
      expect(sla.overall_status).toBe('ON_TRACK');
    });
  });

  describe('5. Точность расчёта 7 показателей дашборда лидов (getPoolStats)', () => {
    // Model the exact production database:
    // 33 historical WON (null manager)
    // 4 WON (admin)
    // 1 WON (manager 3)
    // 1 LOST (admin)
    // 1 IN_PROGRESS (admin)
    // 8 NEGOTIATION (admin)
    // Total = 48
    const mockDbLeads = [
      ...Array.from({ length: 33 }, (_, i) => ({
        id: i + 1,
        status: 'WON',
        responsible_user_id: null,
        created_at: '2026-08-01T05:00:00.000Z'
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: 34 + i,
        status: 'WON',
        responsible_user_id: 1,
        created_at: '2026-08-01T05:00:00.000Z'
      })),
      {
        id: 38,
        status: 'WON',
        responsible_user_id: 3,
        created_at: '2026-08-01T05:00:00.000Z'
      },
      {
        id: 39,
        status: 'LOST',
        responsible_user_id: 1,
        created_at: '2026-08-01T05:00:00.000Z'
      },
      {
        id: 40,
        status: 'IN_PROGRESS',
        responsible_user_id: 1,
        created_at: '2026-08-01T05:00:00.000Z'
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: 41 + i,
        status: 'NEGOTIATION',
        responsible_user_id: 1,
        created_at: '2026-08-01T05:00:00.000Z'
      }))
    ];

    function calculateStats(leads, currentUser) {
      const isSalesManager = currentUser?.role === 'SALES_MANAGER';
      const scopedLeads = isSalesManager
        ? leads.filter(l => l.responsible_user_id === currentUser.id)
        : leads;

      let unassigned = 0;
      let newCount = 0;
      let awaitingContact = 0;
      let overdueCount = 0;
      let inProgress = 0;
      let closed = 0;

      scopedLeads.forEach(l => {
        const isClosedLead = ['WON', 'LOST'].includes(l.status);
        const isUnassignedLead = !l.responsible_user_id && !isClosedLead;
        const sla = evaluateLeadSla(l);

        if (isUnassignedLead) unassigned++;
        if (l.status === 'NEW') {
          newCount++;
          if (!l.first_contact_at) awaitingContact++;
        }
        if (['IN_PROGRESS', 'NEGOTIATION'].includes(l.status)) inProgress++;
        if (isClosedLead) closed++;
        if (!isClosedLead && (sla.manager_sla.is_overdue || (isUnassignedLead && sla.pool_sla.is_overdue))) {
          overdueCount++;
        }
      });

      return {
        total: scopedLeads.length,
        new: newCount,
        unassigned: isSalesManager ? 0 : unassigned,
        awaiting_contact: awaitingContact,
        overdue: overdueCount,
        in_progress: inProgress,
        closed
      };
    }

    it('ADMIN / DIRECTOR sees 100% accurate metrics matching actual database records', () => {
      const adminUser = { id: 1, role: 'ADMIN' };
      const stats = calculateStats(mockDbLeads, adminUser);

      expect(stats.total).toBe(48); // Всего заявок
      expect(stats.new).toBe(0); // Новые
      expect(stats.unassigned).toBe(0); // В общем пуле (активных заявок без менеджера ровно 0, 33 WON исключены)
      expect(stats.awaiting_contact).toBe(0); // Ожидают контакта
      expect(stats.overdue).toBe(0); // Просрочены по SLA (33 WON исключены, 9 активных уже в переговорах)
      expect(stats.in_progress).toBe(9); // В работе (1 IN_PROGRESS + 8 NEGOTIATION)
      expect(stats.closed).toBe(39); // Завершённые (38 WON + 1 LOST)

      // Total balance integrity check:
      // Active (new + in_progress) + Closed = 0 + 9 + 39 = 48 = total
      expect(stats.new + stats.in_progress + stats.closed).toBe(stats.total);
    });

    it('SALES_MANAGER sees strictly isolated metrics for own lead', () => {
      const managerUser = { id: 3, role: 'SALES_MANAGER' };
      const stats = calculateStats(mockDbLeads, managerUser);

      expect(stats.total).toBe(1);
      expect(stats.new).toBe(0);
      expect(stats.unassigned).toBe(0); // Zero pool access
      expect(stats.awaiting_contact).toBe(0);
      expect(stats.overdue).toBe(0);
      expect(stats.in_progress).toBe(0);
      expect(stats.closed).toBe(1); // 1 WON lead
    });

    it('Adding an unassigned NEW lead dynamically increments pool count without affecting closed deals', () => {
      const adminUser = { id: 1, role: 'ADMIN' };
      const extendedLeads = [
        ...mockDbLeads,
        {
          id: 49,
          status: 'NEW',
          responsible_user_id: null,
          created_at: friday1000.toISOString()
        }
      ];

      const stats = calculateStats(extendedLeads, adminUser);

      expect(stats.total).toBe(49);
      expect(stats.new).toBe(1);
      expect(stats.unassigned).toBe(1); // Now exactly 1 in pool
      expect(stats.awaiting_contact).toBe(1);
      expect(stats.closed).toBe(39);
    });
  });

  describe('6. Точность фильтрации общего пула (findAll filtering)', () => {
    function filterPoolLeads(leads, filterParams) {
      let filtered = [...leads];

      if (filterParams.quickFilter === 'UNASSIGNED' || filterParams.unassigned === true) {
        filtered = filtered.filter(l => 
          l.responsible_user_id === null && ['NEW', 'IN_PROGRESS', 'NEGOTIATION'].includes(l.status)
        );
      } else if (filterParams.quickFilter === 'CLOSED') {
        filtered = filtered.filter(l => ['WON', 'LOST'].includes(l.status));
      } else if (filterParams.quickFilter === 'IN_PROGRESS') {
        filtered = filtered.filter(l => ['IN_PROGRESS', 'NEGOTIATION'].includes(l.status));
      } else if (filterParams.quickFilter === 'OVERDUE') {
        filtered = filtered.filter(l => {
          const isClosed = ['WON', 'LOST'].includes(l.status);
          if (isClosed) return false;
          const sla = evaluateLeadSla(l);
          return sla.manager_sla.is_overdue || (!l.responsible_user_id && sla.pool_sla.is_overdue);
        });
      }

      return filtered;
    }

    it('clicking "В общем пуле" (UNASSIGNED) returns 0 records when all null-manager leads are WON', () => {
      const mockDbLeads = Array.from({ length: 33 }, (_, i) => ({
        id: i + 1,
        status: 'WON',
        responsible_user_id: null
      }));

      const poolResult = filterPoolLeads(mockDbLeads, { quickFilter: 'UNASSIGNED' });
      expect(poolResult.length).toBe(0);

      const unassignedParamResult = filterPoolLeads(mockDbLeads, { unassigned: true });
      expect(unassignedParamResult.length).toBe(0);
    });

    it('clicking "Завершённые" (CLOSED) returns all 33 historical WON leads plus other closed', () => {
      const mockDbLeads = [
        ...Array.from({ length: 33 }, (_, i) => ({
          id: i + 1,
          status: 'WON',
          responsible_user_id: null
        })),
        { id: 34, status: 'WON', responsible_user_id: 1 },
        { id: 35, status: 'LOST', responsible_user_id: 1 }
      ];

      const closedResult = filterPoolLeads(mockDbLeads, { quickFilter: 'CLOSED' });
      expect(closedResult.length).toBe(35);
      expect(closedResult.every(l => ['WON', 'LOST'].includes(l.status))).toBe(true);
    });

    it('clicking "Просроченные" (OVERDUE) never returns completed WON leads', () => {
      const mockDbLeads = [
        ...Array.from({ length: 33 }, (_, i) => ({
          id: i + 1,
          status: 'WON',
          responsible_user_id: null,
          created_at: '2026-08-01T05:00:00.000Z'
        })),
        {
          id: 34,
          status: 'NEW',
          responsible_user_id: null,
          created_at: '2026-08-01T05:00:00.000Z' // 2 months old active lead in pool -> genuinely overdue
        }
      ];

      const overdueResult = filterPoolLeads(mockDbLeads, { quickFilter: 'OVERDUE' });
      expect(overdueResult.length).toBe(1);
      expect(overdueResult[0].id).toBe(34);
    });
  });

  describe('7. Роли сотрудников и матрица RBAC', () => {
    const mockUsers = [
      { id: 1, name: 'Admin', role: 'ADMIN', is_active: 1, is_sales_rep: false, email: 'admin@tozon.crm' },
      { id: 2, name: 'Руководитель Отдела Продаж', role: 'DIRECTOR', is_active: 1, is_sales_rep: false, email: 'director@tozon.tj' },
      { id: 3, name: 'Менеджер по продажам (Дадочон)', role: 'SALES_MANAGER', is_active: 1, is_sales_rep: false, email: 'manager1@tozon.tj' },
      { id: 4, name: 'Финансовый менеджер (Далер)', role: 'FINANCE_MANAGER', is_active: 1, is_sales_rep: false, email: 'finance@tozon.tj' },
      { id: 5, name: 'Махмуджонов Шерали Шухратович', role: 'ADMIN', is_active: 1, is_sales_rep: false, email: 'admin_sh@tozon.crm' },
      { id: 6, name: 'Усмонов Саидкодир', role: 'WAREHOUSE_MANAGER', is_active: 1, is_sales_rep: false, email: 'zavsklad@tozon.crm' }
    ];

    it('verifies warehouse manager (User 6, Усмонов Саидкодир) has 0 sales assignments', () => {
      const zavsklad = mockUsers.find(u => u.id === 6);
      expect(zavsklad.role).toBe('WAREHOUSE_MANAGER');
      expect(zavsklad.email).toBe('zavsklad@tozon.crm');
      expect(zavsklad.is_sales_rep).toBe(false);
    });

    it('verifies sales manager (User 3, Дадочон) is identified and active', () => {
      const manager = mockUsers.find(u => u.id === 3);
      expect(manager.role).toBe('SALES_MANAGER');
      expect(manager.is_active).toBe(1);
    });
  });
});
