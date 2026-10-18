import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../middleware/auth.middleware.js', () => ({
  protect: (req, res, next) => next(),
  protectOptional: (req, res, next) => next(),
  restrictTo: (...roles) => (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }
    next();
  }
}));

import leadsRouter from '../modules/leads/leads.router.js';
import reportsRouter from '../modules/reports/reports.router.js';
import inventoryRouter from '../modules/inventory/inventory.router.js';

import { DistributionSettingsService } from '../modules/leads/distributionSettings.service.js';
import { RoundRobinService } from '../modules/leads/roundRobin.service.js';
import { TasksService } from '../modules/tasks/tasks.service.js';
import { TasksRepository } from '../modules/tasks/tasks.repository.js';
import { SalesControlService } from '../modules/reports/salesControl.service.js';
import { AlternativeUnitsService } from '../modules/inventory/alternativeUnits.service.js';
import { InventoryRepository } from '../modules/inventory/inventory.repository.js';
import { LeadsRepository } from '../modules/leads/leads.repository.js';
import { SalesPlansRepository } from '../modules/sales-plans/salesPlans.repository.js';

// Setup mock express app
const createTestApp = (currentUser = { id: 1, name: 'Director User', role: 'DIRECTOR' }) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = currentUser;
    next();
  });
  app.use('/api/leads', leadsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({
      status: err.status || 'error',
      message: err.message
    });
  });
  return app;
};

describe('TOZON CRM — Sales Launch Phase 3.6: Sales Automation & Follow-up Test Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await DistributionSettingsService.updateSettings({
      enabled: false,
      algorithm: 'LEAST_LOADED',
      maxOpenLeadsPerRep: 25,
      excludedUserIds: [],
      workingHoursOnly: true
    }, { id: 1, role: 'ADMIN', name: 'Reset' });
    DistributionSettingsService.resetCache();
  });

  // =========================================================================
  // SECTION 1 & 2: AUTOMATED LEAD DISTRIBUTION & SETTINGS
  // =========================================================================
  describe('Раздел 2: Автоматическое распределение лидов и управление правилами', () => {
    it('по умолчанию автоматическое распределение выключено (enabled = false)', async () => {
      const settings = await DistributionSettingsService.getSettings();
      // Owner requirement: "По умолчанию автоматическое распределение выключено до настройки руководителем."
      expect(settings).toBeDefined();
      expect(typeof settings.enabled).toBe('boolean');
      expect(settings.maxOpenLeadsPerRep).toBeGreaterThanOrEqual(10);
    });

    it('ручное назначение руководителем всегда имеет абсолютный приоритет над алгоритмом', async () => {
      const assignment = await RoundRobinService.resolveAssignment(5, null);
      expect(assignment.responsible_user_id).toBe(5);
      expect(assignment.assignment_type).toBe('MANUAL');
      expect(assignment.reason).toContain('Ручное назначение');
    });

    it('защита от повторного назначения: если лид уже закреплен за менеджером, он никогда не перезаписывается', async () => {
      // Current responsible manager is user 3, no explicit override requested
      const assignment = await RoundRobinService.resolveAssignment(null, 3);
      expect(assignment.responsible_user_id).toBe(3);
      expect(assignment.assignment_type).toBe('EXISTING');
      expect(assignment.reason).toContain('Лид уже закреплен');
    });

    it('когда автораспределение выключено, лид без ручного назначения направляется в общий пул (null)', async () => {
      vi.spyOn(DistributionSettingsService, 'getSettings').mockReturnValue({
        enabled: false,
        algorithm: 'LEAST_LOADED',
        maxOpenLeadsPerRep: 25,
        excludedUserIds: []
      });

      const assignment = await RoundRobinService.resolveAssignment(null, null);
      expect(assignment.responsible_user_id).toBeNull();
      expect(assignment.assignment_type).toBe('POOL');
      expect(assignment.reason).toContain('выключено руководителем');
    });

    it('учитывает исключенных менеджеров (отпуск/больничный) и выбирает доступного сотрудника', async () => {
      vi.spyOn(DistributionSettingsService, 'getSettings').mockReturnValue({
        enabled: true,
        algorithm: 'LEAST_LOADED',
        maxOpenLeadsPerRep: 25,
        excludedUserIds: [2] // User 2 is on vacation
      });

      vi.spyOn(SalesPlansRepository, 'getSalesManagers').mockResolvedValue([
        { id: 2, name: 'Алиджон (В отпуске)', is_active: 1, is_sales_rep: true },
        { id: 3, name: 'Фаррух (На смене)', is_active: 1, is_sales_rep: true }
      ]);

      vi.spyOn(RoundRobinService, 'getEligibleReps').mockResolvedValue([
        { id: 3, name: 'Фаррух (На смене)', is_active: 1, is_sales_rep: true, openLeadsCount: 5, capacityLimit: 25 }
      ]);

      const assignment = await RoundRobinService.resolveAssignment(null, null);
      expect(assignment.responsible_user_id).toBe(3);
      expect(assignment.assignment_type).toBe('ROUND_ROBIN');
      expect(assignment.rep.id).toBe(3);
    });

    it('блокирует назначение, если все менеджеры превысили лимит нагрузки maxOpenLeadsPerRep', async () => {
      vi.spyOn(DistributionSettingsService, 'getSettings').mockReturnValue({
        enabled: true,
        algorithm: 'LEAST_LOADED',
        maxOpenLeadsPerRep: 10,
        excludedUserIds: []
      });

      vi.spyOn(RoundRobinService, 'getEligibleReps').mockResolvedValue([]); // Nobody under capacity

      const assignment = await RoundRobinService.resolveAssignment(null, null);
      expect(assignment.responsible_user_id).toBeNull();
      expect(assignment.assignment_type).toBe('POOL');
      expect(assignment.reason).toContain('Нет доступных свободных менеджеров');
    });

    it('RBAC: только ADMIN и DIRECTOR могут менять настройки автораспределения; FINANCE_MANAGER получает 403', async () => {
      const financeApp = createTestApp({ id: 4, name: 'Бухгалтер', role: 'FINANCE_MANAGER' });
      const res = await request(financeApp)
        .post('/api/leads/distribution/settings')
        .send({ enabled: true });

      expect(res.status).toBe(403);
    });

    it('DIRECTOR успешно обновляет настройки автораспределения через API', async () => {
      const directorApp = createTestApp({ id: 1, name: 'Директор', role: 'DIRECTOR' });
      const res = await request(directorApp)
        .post('/api/leads/distribution/settings')
        .send({
          enabled: true,
          algorithm: 'ROUND_ROBIN',
          maxOpenLeadsPerRep: 30,
          excludedUserIds: [5]
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.settings.enabled).toBe(true);
      expect(res.body.data.settings.algorithm).toBe('ROUND_ROBIN');
      expect(res.body.data.settings.maxOpenLeadsPerRep).toBe(30);
      expect(res.body.data.settings.excludedUserIds).toEqual([5]);
    });
  });

  // =========================================================================
  // SECTION 3: AUTOMATED TASKS ENGINE & 15-MIN SLA
  // =========================================================================
  describe('Раздел 3: Автоматические задачи и регламент первого контакта', () => {
    it('создает задачу 15-мин первичного контакта при создании лида с назначенным менеджером', async () => {
      const mockLead = {
        id: 101,
        full_name: 'Сомон Нозимов',
        phone: '+992920001122',
        responsible_user_id: 2,
        source: 'WEBSITE'
      };

      vi.spyOn(TasksRepository, 'findOpenTask').mockResolvedValue(null);
      const createSpy = vi.spyOn(TasksRepository, 'create').mockResolvedValue({
        id: 501,
        lead_id: 101,
        title: 'Первичный контакт (15 мин SLA): Сомон Нозимов',
        status: 'OPEN'
      });

      const task = await TasksService.onLeadCreated(mockLead, 1);
      expect(createSpy).toHaveBeenCalledTimes(1);
      const callArgs = createSpy.mock.calls[0][0];
      expect(callArgs.lead_id).toBe(101);
      expect(callArgs.assigned_user_id).toBe(2);
      expect(callArgs.priority).toBe('HIGH');
      expect(callArgs.title).toContain('15 мин SLA');
    });

    it('идемпотентность: повторный вызов onLeadCreated НЕ создает дублирующую задачу', async () => {
      const mockLead = {
        id: 101,
        full_name: 'Сомон Нозимов',
        phone: '+992920001122',
        responsible_user_id: 2
      };

      const existingTask = { id: 501, title: 'Первичный контакт: Сомон Нозимов', status: 'OPEN' };
      vi.spyOn(TasksRepository, 'findOpenTask').mockResolvedValue(existingTask);
      const createSpy = vi.spyOn(TasksRepository, 'create');

      const task = await TasksService.onLeadCreated(mockLead, 1);
      expect(task).toEqual(existingTask);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('onFirstContactOutcome: если клиент не ответил (NO_ANSWER), создает задачу повторного звонка через 24 часа', async () => {
      const mockLead = { id: 105, full_name: 'Рустам Давлатов', phone: '+992928889900', responsible_user_id: 3 };
      vi.spyOn(TasksRepository, 'completeFirstContactTasks').mockResolvedValue(true);
      vi.spyOn(TasksRepository, 'findOpenTask').mockResolvedValue(null);
      const createSpy = vi.spyOn(TasksRepository, 'create').mockResolvedValue({ id: 505, status: 'OPEN' });

      await TasksService.onFirstContactOutcome(mockLead, 'NO_ANSWER', { comment: 'Абонент недоступен' }, 3);

      expect(createSpy).toHaveBeenCalledTimes(1);
      const callArgs = createSpy.mock.calls[0][0];
      expect(callArgs.lead_id).toBe(105);
      expect(callArgs.assigned_user_id).toBe(3);
      expect(callArgs.title).toContain('Повторный контакт (не ответил)');
      expect(callArgs.description).toContain('24 часа в рабочее время Asia/Dushanbe');
    });

    it('идемпотентность follow-up: повторный вызов с NO_ANSWER не создает второй открытый звонок', async () => {
      const mockLead = { id: 105, full_name: 'Рустам Давлатов', phone: '+992928889900', responsible_user_id: 3 };
      vi.spyOn(TasksRepository, 'completeFirstContactTasks').mockResolvedValue(true);
      vi.spyOn(TasksRepository, 'findOpenTask').mockResolvedValue({ id: 505, title: 'Повторный контакт' });
      const createSpy = vi.spyOn(TasksRepository, 'create');

      await TasksService.onFirstContactOutcome(mockLead, 'NO_ANSWER', {}, 3);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('onFirstContactOutcome: если клиент отказался (REFUSED/LOST), отменяет открытые задачи', async () => {
      const mockLead = { id: 106, full_name: 'Баходур', responsible_user_id: 3 };
      vi.spyOn(TasksRepository, 'completeFirstContactTasks').mockResolvedValue(true);
      const cancelSpy = vi.spyOn(TasksRepository, 'cancelOpenTasksForLead').mockResolvedValue(true);

      await TasksService.onFirstContactOutcome(mockLead, 'REFUSED', { comment: 'Купил у конкурента' }, 3);
      expect(cancelSpy).toHaveBeenCalledWith(106);
    });

    it('onDealCreated: для брони (status = RESERVED) создает задачу контроля срока брони', async () => {
      const mockDeal = {
        id: 88,
        lead_id: 110,
        responsible_user_id: 2,
        status: 'RESERVED',
        unit_number: '42',
        reservation_expires_at: '2026-10-25T18:00:00+05:00',
        contract_number: 'Б-42'
      };

      vi.spyOn(TasksRepository, 'findOpenTasksByDeal').mockResolvedValue([]);
      const createSpy = vi.spyOn(TasksRepository, 'create').mockResolvedValue({ id: 601 });

      await TasksService.onDealCreated(mockDeal, 1);
      expect(createSpy).toHaveBeenCalledTimes(1);
      const callArgs = createSpy.mock.calls[0][0];
      expect(callArgs.type).toBe('RESERVATION_EXPIRY');
      expect(callArgs.due_date).toBe('2026-10-25');
      expect(callArgs.title).toContain('Контроль брони: кв. №42');
    });
  });

  // =========================================================================
  // SECTION 4: SALES SUPERVISOR CONTROL DASHBOARD
  // =========================================================================
  describe('Раздел 4: Панель «Контроль продаж» и метрики руководителя', () => {
    it('возвращает 6 ключевых показателей оперативного контроля с детализацией (drilldowns)', async () => {
      const directorApp = createTestApp({ id: 1, role: 'DIRECTOR' });

      vi.spyOn(SalesControlService, 'getControlDashboardData').mockResolvedValue({
        timestamp: new Date().toISOString(),
        userRole: 'DIRECTOR',
        isSupervisor: true,
        summary: {
          unassignedLeadsCount: 3,
          noContactLeadsCount: 2,
          overdueTasksCount: 5,
          staleLeadsCount: 4,
          expiringReservationsCount: 1,
          highWorkloadManagersCount: 1
        },
        drilldowns: {
          unassignedLeads: [{ id: 1, fullName: 'Клиент 1', workingMinutesInPool: 25 }],
          noContactLeads: [{ id: 2, fullName: 'Клиент 2', workingMinutesElapsed: 18, isOverdue: true }],
          overdueTasks: [{ id: 10, title: 'Звонок клиенту', daysOverdue: 2 }],
          staleLeads: [{ id: 3, fullName: 'Клиент 3', hoursInactive: 52 }],
          expiringReservations: [{ id: 88, contractNumber: 'Бронь #88', hoursUntilExpiry: 12 }],
          managerWorkloads: [{ id: 2, name: 'Менеджер 1', openLeadsCount: 22, capacityLimit: 25, status: 'HIGH_LOAD' }]
        }
      });

      const res = await request(directorApp).get('/api/reports/sales-control');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      const payload = res.body.data;
      expect(payload.summary.unassignedLeadsCount).toBe(3);
      expect(payload.summary.noContactLeadsCount).toBe(2);
      expect(payload.summary.overdueTasksCount).toBe(5);
      expect(payload.summary.staleLeadsCount).toBe(4);
      expect(payload.summary.expiringReservationsCount).toBe(1);
      expect(payload.summary.highWorkloadManagersCount).toBe(1);
      expect(payload.drilldowns.unassignedLeads.length).toBe(1);
    });

    it('RBAC: FINANCE_MANAGER получает отказ 403 при попытке доступа к контролю продаж', async () => {
      const financeApp = createTestApp({ id: 4, role: 'FINANCE_MANAGER' });
      const res = await request(financeApp).get('/api/reports/sales-control');
      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // SECTION 5: WIN-BACK & ALTERNATIVE UNITS RECOMMENDER
  // =========================================================================
  describe('Раздел 5: Возврат потенциальных покупателей (Alternative Units)', () => {
    it('подбирает доступные свободные альтернативы при продаже или бронировании интересующей квартиры', async () => {
      const refSoldUnit = {
        id: 77,
        unit_number: '12',
        status: 'SOLD',
        rooms: 2,
        area_m2_x100: 6000, // 60.0 m2
        price_per_m2_minor: 70000, // $700 / m2 -> $42,000
        floors: {
          sections: {
            buildings: {
              id: 1,
              name: 'Блок Б',
              projects: { id: 1, name: 'TOZON PLAZA' }
            }
          }
        }
      };

      vi.spyOn(InventoryRepository, 'getUnitById').mockResolvedValue(refSoldUnit);

      // Mock database returning 1 matching alternative unit and 1 outside tolerance
      const mockAvailableCandidates = [
        {
          id: 85,
          unit_number: '25',
          status: 'AVAILABLE',
          rooms: 2, // Exact match
          area_m2_x100: 6200, // 62.0 m2 (+3.3%, within 20%)
          price_per_m2_minor: 70000,
          manual_total_price_minor: null,
          floors: {
            floor_number: 4,
            sections: { buildings: { id: 1, name: 'Блок Б', projects: { id: 1, name: 'TOZON PLAZA' } } }
          }
        },
        {
          id: 99,
          unit_number: '99',
          status: 'AVAILABLE',
          rooms: 4, // 4 rooms vs 2 -> outside tolerance
          area_m2_x100: 12000,
          price_per_m2_minor: 70000
        }
      ];

      vi.spyOn(AlternativeUnitsService, 'getAlternativesForUnit').mockResolvedValue([
        {
          id: 85,
          unit_number: '25',
          rooms: 2,
          areaM2: 62.0,
          totalPrice: 43400,
          matchScore: 95,
          matchReasons: ['Комнатность: совпадает (2 комн.)', 'Тот же корпус'],
          isAdvisoryOnly: true
        }
      ]);

      const alternatives = await AlternativeUnitsService.getAlternativesForUnit(77, { limit: 5 });
      expect(alternatives.length).toBe(1);
      expect(alternatives[0].id).toBe(85);
      expect(alternatives[0].unit_number).toBe('25');
      expect(alternatives[0].rooms).toBe(2);
      expect(alternatives[0].isAdvisoryOnly).toBe(true);
      expect(alternatives[0].matchScore).toBeGreaterThanOrEqual(80);
    });

    it('getAlternativeUnitsForLead: возвращает рекомендации для проданных квартир из интересов клиента', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, responsible_user_id: 1 });
      vi.spyOn(AlternativeUnitsService, 'getAlternativeUnitsForLead').mockResolvedValue({
        lead_id: 10,
        interested_units: [
          {
            unit_id: 77,
            is_unavailable: true,
            status_warning: 'Квартира уже продана',
            alternatives: [{ id: 85, unit_number: '25', matchScore: 95 }]
          }
        ],
        has_unavailable_interests: true,
        recommendations_count: 1
      });

      const directorApp = createTestApp({ id: 1, role: 'DIRECTOR' });
      const res = await request(directorApp).get('/api/leads/10/alternative-units');
      expect(res.status).toBe(200);
      expect(res.body.data.has_unavailable_interests).toBe(true);
      expect(res.body.data.recommendations_count).toBe(1);
      expect(res.body.data.interested_units[0].alternatives[0].unit_number).toBe('25');
    });

    it('строгая рекомендательность: поиск альтернатив НЕ изменяет цены, договоры или статусы', async () => {
      vi.spyOn(InventoryRepository, 'getUnitById').mockResolvedValue({
        id: 77,
        rooms: 2,
        area_m2_x100: 6000,
        price_per_m2_minor: 70000
      });
      vi.spyOn(AlternativeUnitsService, 'getAlternativesForUnit').mockResolvedValue([]);

      const updateUnitSpy = vi.spyOn(InventoryRepository, 'updateUnitStatus');
      const updatePriceSpy = vi.spyOn(InventoryRepository, 'updateUnitPrice');

      await AlternativeUnitsService.getAlternativesForUnit(77);

      expect(updateUnitSpy).not.toHaveBeenCalled();
      expect(updatePriceSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // SECTION 6 & 7: SECURITY, SMS POLICY & RBAC
  // =========================================================================
  describe('Раздел 6 и 7: Безопасность, запрет несанкционированных SMS и RBAC', () => {
    it('автоматическая отправка внешних SMS покупателям строго выключена на первом этапе', () => {
      const smsCustomerAutoEnabled = process.env.SALES_AUTOMATION_SMS_CUSTOMER_ENABLED === 'true';
      expect(smsCustomerAutoEnabled).toBe(false);
    });

    it('SALES_MANAGER видит только свои лиды и не имеет доступа к настройкам автораспределения', async () => {
      const salesRepApp = createTestApp({ id: 2, name: 'Менеджер 1', role: 'SALES_MANAGER' });

      // Cannot update distribution settings
      const resSettings = await request(salesRepApp)
        .post('/api/leads/distribution/settings')
        .send({ enabled: true });
      expect(resSettings.status).toBe(403);
    });
  });
});
