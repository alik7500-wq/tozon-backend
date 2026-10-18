import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../db/connection.js', () => ({
  getDB: vi.fn(),
  getServiceDB: vi.fn(),
  connectDB: vi.fn()
}));

import leadsRouter from '../modules/leads/leads.router.js';
import tasksRouter from '../modules/tasks/tasks.router.js';
import { DistributionSettingsService } from '../modules/leads/distributionSettings.service.js';
import { RoundRobinService } from '../modules/leads/roundRobin.service.js';
import { TasksService } from '../modules/tasks/tasks.service.js';
import { TasksRepository } from '../modules/tasks/tasks.repository.js';
import { LeadsRepository } from '../modules/leads/leads.repository.js';
import { SalesPlansRepository } from '../modules/sales-plans/salesPlans.repository.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { getDB, getServiceDB } from '../db/connection.js';

const createTestApp = (currentUser = { id: 1, name: 'Director User', role: 'DIRECTOR' }) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = currentUser;
    next();
  });
  app.use('/api/leads', leadsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({
      status: err.status || 'error',
      message: err.message
    });
  });
  return app;
};

describe('TOZON CRM — Phase 3.6 Concurrency, Security & Integrity Test Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    RoundRobinService.resetInFlight();
    TasksService._clearTaskLocks();
    LeadsRepository._clearAssignmentLocks();

    const defaultMockDb = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: {}, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: {}, error: null })
      }))
    };
    getDB.mockReturnValue(defaultMockDb);
    getServiceDB.mockReturnValue(defaultMockDb);
  });

  // =========================================================================
  // 1. CONCURRENT LEAD ASSIGNMENT & CAPACITY GUARD (25 LIMIT)
  // =========================================================================
  describe('1. Аудит конкурентного распределения лидов и лимита 25 лидов', () => {
    it('параллельные запросы не могут превысить лимит 25 открытых лидов на менеджера', async () => {
      vi.spyOn(DistributionSettingsService, 'getSettings').mockReturnValue({
        enabled: true,
        algorithm: 'LEAST_LOADED',
        maxOpenLeadsPerRep: 25,
        excludedUserIds: [],
        workingHoursOnly: false
      });

      // Manager 1 has 24 leads (capacity 25, only 1 slot left)
      // Manager 2 has 25 leads (capacity 25, 0 slots left)
      vi.spyOn(SalesPlansRepository, 'getSalesManagers').mockResolvedValue([
        { id: 10, name: 'Менеджер 1 (24 лида)', is_active: 1, is_sales_rep: true },
        { id: 20, name: 'Менеджер 2 (25 лидов)', is_active: 1, is_sales_rep: true }
      ]);

      const mockDb = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            in: vi.fn(() => ({
              in: vi.fn(() => ({
                is: vi.fn().mockResolvedValue({
                  data: [
                    ...Array(24).fill({ id: 1, responsible_user_id: 10 }),
                    ...Array(25).fill({ id: 2, responsible_user_id: 20 })
                  ],
                  error: null
                })
              }))
            }))
          }))
        }))
      };
      getDB.mockReturnValue(mockDb);

      // Simulate 3 concurrent incoming leads arriving at the exact same millisecond
      const [res1, res2, res3] = await Promise.all([
        RoundRobinService.resolveAssignment(),
        RoundRobinService.resolveAssignment(),
        RoundRobinService.resolveAssignment()
      ]);

      // Exactly 1 lead can be assigned to Manager 1 (reaching 25)
      // The other 2 leads must gracefully fallback to POOL (since neither rep has capacity)
      const assignedToRep10 = [res1, res2, res3].filter(r => r.responsible_user_id === 10);
      const fallbackToPool = [res1, res2, res3].filter(r => r.responsible_user_id === null && r.assignment_type === 'POOL');

      expect(assignedToRep10.length).toBe(1);
      expect(fallbackToPool.length).toBe(2);

      // Cleanup slots
      if (res1.releaseSlot) res1.releaseSlot();
      if (res2.releaseSlot) res2.releaseSlot();
      if (res3.releaseSlot) res3.releaseSlot();
    });

    it('LEAST_LOADED учитывает актуальную нагрузку и резервы in-flight при одновременных вызовах', async () => {
      vi.spyOn(DistributionSettingsService, 'getSettings').mockReturnValue({
        enabled: true,
        algorithm: 'LEAST_LOADED',
        maxOpenLeadsPerRep: 25,
        excludedUserIds: [],
        workingHoursOnly: false
      });

      // Manager 1 has 5 leads, Manager 2 has 10 leads
      vi.spyOn(SalesPlansRepository, 'getSalesManagers').mockResolvedValue([
        { id: 101, name: 'Менеджер А', is_active: 1, is_sales_rep: true },
        { id: 102, name: 'Менеджер Б', is_active: 1, is_sales_rep: true }
      ]);

      const mockDb = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            in: vi.fn(() => ({
              in: vi.fn(() => ({
                is: vi.fn().mockResolvedValue({
                  data: [
                    ...Array(5).fill({ id: 1, responsible_user_id: 101 }),
                    ...Array(10).fill({ id: 2, responsible_user_id: 102 })
                  ],
                  error: null
                })
              }))
            }))
          }))
        }))
      };
      getDB.mockReturnValue(mockDb);

      // Fire 3 assignments in parallel
      const [a1, a2, a3] = await Promise.all([
        RoundRobinService.resolveAssignment(),
        RoundRobinService.resolveAssignment(),
        RoundRobinService.resolveAssignment()
      ]);

      // All 3 go to Manager A because initial workload (5) + inFlight (1, 2) is 5, 6, 7 < 10
      expect(a1.responsible_user_id).toBe(101);
      expect(a2.responsible_user_id).toBe(101);
      expect(a3.responsible_user_id).toBe(101);

      // Verify in-flight count was tracked
      expect(RoundRobinService.getInFlightWorkload(101)).toBe(3);

      // Clean up
      a1.releaseSlot();
      a2.releaseSlot();
      a3.releaseSlot();
      expect(RoundRobinService.getInFlightWorkload(101)).toBe(0);
    });

    it('ручное назначение имеет приоритет над автораспределением', async () => {
      vi.spyOn(DistributionSettingsService, 'getSettings').mockReturnValue({
        enabled: true,
        algorithm: 'LEAST_LOADED',
        maxOpenLeadsPerRep: 25
      });

      const assignment = await RoundRobinService.resolveAssignment(99, null);
      expect(assignment.responsible_user_id).toBe(99);
      expect(assignment.assignment_type).toBe('MANUAL');
    });

    it('неактивные и исключенные сотрудники не участвуют в распределении', async () => {
      vi.spyOn(DistributionSettingsService, 'getSettings').mockReturnValue({
        enabled: true,
        algorithm: 'LEAST_LOADED',
        maxOpenLeadsPerRep: 25,
        excludedUserIds: [2], // User 2 is excluded
        workingHoursOnly: false
      });

      vi.spyOn(SalesPlansRepository, 'getSalesManagers').mockResolvedValue([
        { id: 1, name: 'Active Ineligible Non-Rep', is_active: 1, is_sales_rep: false },
        { id: 2, name: 'Excluded Rep on leave', is_active: 1, is_sales_rep: true },
        { id: 3, name: 'Inactive Rep', is_active: 0, is_sales_rep: true },
        { id: 4, name: 'Eligible Rep', is_active: 1, is_sales_rep: true }
      ]);

      const mockDb = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            in: vi.fn(() => ({
              in: vi.fn(() => ({
                is: vi.fn().mockResolvedValue({ data: [], error: null })
              }))
            }))
          }))
        }))
      };
      getDB.mockReturnValue(mockDb);

      const eligible = await RoundRobinService.getEligibleReps();
      expect(eligible.length).toBe(1);
      expect(eligible[0].id).toBe(4);
    });

    it('блокировка предотвращает одновременное конфликтное назначение одного лида', async () => {
      const leadId = 555;
      let resolveFirstCall;
      const firstCallHold = new Promise(res => { resolveFirstCall = res; });

      vi.spyOn(LeadsRepository, 'findById').mockImplementation(async () => {
        await firstCallHold;
        return { id: leadId, responsible_user_id: null, full_name: 'Race Lead' };
      });

      const mockDb = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: 1, name: 'Active Rep', role: 'SALES_MANAGER', is_active: 1, is_sales_rep: true },
            error: null
          }),
          update: vi.fn().mockReturnThis(),
          insert: vi.fn().mockResolvedValue({ data: {}, error: null })
        }))
      };
      getDB.mockReturnValue(mockDb);
      getServiceDB.mockReturnValue(mockDb);

      // Start first assignment
      const p1 = LeadsRepository.assignManager(leadId, 1, 'First assign', 1);

      // Second assignment attempts to acquire the lock for the exact same leadId
      const p2 = LeadsRepository.assignManager(leadId, 2, 'Second assign', 1);

      // p2 should be rejected with 409 Conflict immediately because p1 is in flight
      await expect(p2).rejects.toThrow('Операция назначения для данного лида уже выполняется');

      // Unblock p1
      resolveFirstCall();
      try {
        await p1;
      } catch {
        // ok
      }
    });
  });

  // =========================================================================
  // 2. AUTOMATED TASKS, SHORT RESERVATIONS & IDEMPOTENCY
  // =========================================================================
  describe('2. Аудит автоматических задач, идемпотентности и бронирований', () => {
    it('параллельные события создания лида создают ровно одну задачу первичного контакта', async () => {
      const lead = { id: 701, full_name: 'Parallel Lead', phone: '+992900000001', responsible_user_id: 5, source: 'WEBSITE' };

      const createSpy = vi.spyOn(TasksRepository, 'create').mockResolvedValue({ id: 1, title: 'Первичный контакт' });
      vi.spyOn(TasksRepository, 'findOpenTask').mockResolvedValue(null);

      // Call onLeadCreated 3 times simultaneously
      await Promise.all([
        TasksService.onLeadCreated(lead, 5),
        TasksService.onLeadCreated(lead, 5),
        TasksService.onLeadCreated(lead, 5)
      ]);

      // Only 1 task created due to in-flight lock
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('короткие бронирования (<48 часов) помечаются как [СРОЧНО <48ч] с приоритетом HIGH', async () => {
      const now = new Date();
      // Expiry 24 hours from now (<48 hours)
      const expiry = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();

      const deal = {
        id: 88,
        lead_id: 200,
        unit_number: '42B',
        contract_number: 'BR-88',
        status: 'RESERVED',
        reservation_expires_at: expiry,
        responsible_user_id: 3
      };

      vi.spyOn(TasksRepository, 'findOpenTasksByDeal').mockResolvedValue([]);
      const createSpy = vi.spyOn(TasksRepository, 'create').mockResolvedValue({ id: 99 });

      await TasksService.onDealCreated(deal, 1);

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'RESERVATION_EXPIRY',
        priority: 'HIGH',
        title: expect.stringContaining('[СРОЧНО <48ч] Контроль брони'),
        description: expect.stringContaining('Короткий срок бронирования (<48 часов)')
      }));
    });

    it('просроченные бронирования помечаются как [ПРОСРОЧЕНА] со сроком today', async () => {
      const pastExpiry = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const todayStr = new Date().toISOString().split('T')[0];

      const deal = {
        id: 89,
        lead_id: 201,
        unit_number: '15A',
        contract_number: 'BR-89',
        status: 'RESERVED',
        reservation_expires_at: pastExpiry,
        responsible_user_id: 3
      };

      vi.spyOn(TasksRepository, 'findOpenTasksByDeal').mockResolvedValue([]);
      const createSpy = vi.spyOn(TasksRepository, 'create').mockResolvedValue({ id: 100 });

      await TasksService.onDealCreated(deal, 1);

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'RESERVATION_EXPIRY',
        priority: 'HIGH',
        title: expect.stringContaining('[ПРОСРОЧЕНА] Контроль брони'),
        due_date: todayStr,
        description: expect.stringContaining('Внимание: срок бронирования истек!')
      }));
    });

    it('при отказе лида (LOST) отменяются ТОЛЬКО задачи контакта, финансовые и договорные не трогаются', async () => {
      const leadId = 333;
      let capturedIsCol = null;
      let capturedIsVal = null;
      let capturedTypes = null;

      const mockDb = {
        from: vi.fn((table) => {
          expect(table).toBe('tasks');
          return {
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn((col, val) => {
                    capturedIsCol = col;
                    capturedIsVal = val;
                    return {
                      in: vi.fn((typeCol, types) => {
                        capturedTypes = types;
                        return Promise.resolve({ error: null });
                      })
                    };
                  })
                }))
              }))
            }))
          };
        })
      };

      getDB.mockReturnValue(mockDb);
      getServiceDB.mockReturnValue(mockDb);

      await TasksRepository.cancelOpenTasksForLead(leadId);

      expect(capturedIsCol).toBe('deal_id');
      expect(capturedIsVal).toBeNull();
      expect(capturedTypes).toEqual(['CALL', 'MEETING']);
    });
  });

  // =========================================================================
  // 3. API SECURITY & RBAC IDOR TESTS
  // =========================================================================
  describe('3. Безопасность API, серверный RBAC и предотвращение IDOR', () => {
    it('SALES_MANAGER не может создать лид с чужим responsible_user_id (IDOR spoofing blocked)', async () => {
      const app = createTestApp({ id: 5, name: 'Sales Rep 5', role: 'SALES_MANAGER' });

      let capturedPayload = null;
      vi.spyOn(LeadsRepository, 'create').mockImplementation(async (payload) => {
        capturedPayload = payload;
        return { id: 777, ...payload };
      });
      vi.spyOn(TasksService, 'onLeadCreated').mockResolvedValue({});

      // Attacker tries to pass responsible_user_id = 999 (another rep)
      const res = await request(app)
        .post('/api/leads')
        .send({
          full_name: 'IDOR Test',
          phone: '+992900000099',
          responsible_user_id: 999
        });

      expect(res.status).toBe(201);
      // Verified: responsible_user_id was strictly forced to req.user.id (5)
      expect(capturedPayload.responsible_user_id).toBe(5);
    });

    it('SALES_MANAGER не может получить чужой лид по ID (403 Forbidden)', async () => {
      const app = createTestApp({ id: 5, name: 'Sales Rep 5', role: 'SALES_MANAGER' });

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        id: 888,
        full_name: 'Other Rep Lead',
        responsible_user_id: 10 // Assigned to Rep 10
      });

      const res = await request(app).get('/api/leads/888');
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('нет доступа');
    });

    it('SALES_MANAGER не может просматривать лиды из общего пула (403 Forbidden)', async () => {
      const app = createTestApp({ id: 5, name: 'Sales Rep 5', role: 'SALES_MANAGER' });

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        id: 889,
        full_name: 'Pool Lead',
        responsible_user_id: null // Unassigned pool
      });

      const res = await request(app).get('/api/leads/889');
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('общего пула');
    });

    it('FINANCE_MANAGER не имеет доступа к созданию лидов (403 Forbidden)', async () => {
      const app = createTestApp({ id: 6, name: 'Finance User', role: 'FINANCE_MANAGER' });

      const res = await request(app)
        .post('/api/leads')
        .send({ full_name: 'Finance Lead Attempt', phone: '+992900000088' });

      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // 4. SMS STRICTLY DISABLED CONFIRMATION
  // =========================================================================
  describe('4. Подтверждение строгого отключения SMS покупателям', () => {
    it('автоматические SMS покупателям выключены до разрешения владельца', () => {
      const isSmsEnabled = process.env.SALES_AUTOMATION_SMS_CUSTOMER_ENABLED === 'true';
      expect(isSmsEnabled).toBe(false);
    });
  });

  // =========================================================================
  // 5. TASKS RBAC, POSTGREST ISOLATION & MULTI-INSTANCE ATOMICITY
  // =========================================================================
  describe('5. Безопасность таблицы tasks, PostgREST изоляция и многоэкземплярная атомарность', () => {
    it('WAREHOUSE_MANAGER не имеет доступа к задачам (403 Forbidden)', async () => {
      const app = createTestApp({ id: 9, name: 'Warehouse User', role: 'WAREHOUSE_MANAGER' });

      const resGet = await request(app).get('/api/tasks');
      expect(resGet.status).toBe(403);
      expect(resGet.body.message).toContain('нет доступа к задачам');

      const resPost = await request(app).post('/api/tasks').send({ title: 'Illegal Task' });
      expect(resPost.status).toBe(403);
    });

    it('SALES_MANAGER не может назначить создаваемую задачу другому менеджеру (IDOR spoofing blocked)', async () => {
      const app = createTestApp({ id: 5, name: 'Sales Rep 5', role: 'SALES_MANAGER' });

      let capturedTaskData = null;
      vi.spyOn(TasksRepository, 'create').mockImplementation(async (data) => {
        capturedTaskData = data;
        return { id: 101, ...data };
      });

      // Attacker tries to create task assigned to manager 999
      const res = await request(app)
        .post('/api/tasks')
        .send({
          title: 'Follow-up Call',
          assigned_user_id: 999,
          type: 'CALL'
        });

      expect(res.status).toBe(201);
      // Forced to req.user.id (5)
      expect(capturedTaskData.assigned_user_id).toBe(5);
    });

    it('SALES_MANAGER не может изменить назначенного менеджера при обновлении задачи', async () => {
      const app = createTestApp({ id: 5, name: 'Sales Rep 5', role: 'SALES_MANAGER' });

      vi.spyOn(TasksRepository, 'findById').mockResolvedValue({
        id: 102,
        title: 'Original Task',
        assigned_user_id: 5
      });

      let capturedUpdateData = null;
      vi.spyOn(TasksRepository, 'update').mockImplementation(async (id, data) => {
        capturedUpdateData = data;
        return { id, ...data };
      });

      // Attacker tries to reassign task to manager 888
      const res = await request(app)
        .put('/api/tasks/102')
        .send({
          title: 'Updated Task',
          assigned_user_id: 888
        });

      expect(res.status).toBe(200);
      // assigned_user_id was stripped from update payload for SALES_MANAGER
      expect(capturedUpdateData.assigned_user_id).toBeUndefined();
    });

    it('SALES_MANAGER не может удалить системную задачу по сделке (403 Forbidden)', async () => {
      const app = createTestApp({ id: 5, name: 'Sales Rep 5', role: 'SALES_MANAGER' });

      vi.spyOn(TasksRepository, 'findById').mockResolvedValue({
        id: 103,
        title: 'Deal Follow-up',
        assigned_user_id: 5,
        deal_id: 55, // Critical deal task
        type: 'CALL'
      });

      const res = await request(app).delete('/api/tasks/103');
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('запрещено менеджерам продаж');
    });

    it('TasksRepository.create корректно восстанавливается при конфликте 23505 (partial unique index deduplication)', async () => {
      const existingTask = {
        id: 205,
        lead_id: 44,
        type: 'CALL',
        status: 'OPEN',
        title: 'Первичный контакт (15 мин SLA)'
      };

      const mockDb = {
        from: vi.fn((table) => {
          if (table === 'tasks') {
            return {
              insert: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: vi.fn().mockRejectedValue({
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "uq_tasks_open_lead_call"'
                  })
                }))
              })),
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    eq: vi.fn().mockResolvedValue({
                      data: [existingTask],
                      error: null
                    })
                  }))
                }))
              }))
            };
          }
        })
      };

      getServiceDB.mockReturnValue(mockDb);

      const result = await TasksRepository.create({
        lead_id: 44,
        type: 'CALL',
        title: 'Первичный контакт (15 мин SLA)'
      });

      // Recovered smoothly without throwing 500!
      expect(result).toBeDefined();
      expect(result.id).toBe(205);
    });

    it('LeadsRepository.assignManager использует fn_assign_lead_atomic при наличии RPC и плавно откатывается при его отсутствии', async () => {
      // 1. With RPC available
      vi.spyOn(TasksService, 'onLeadAssigned').mockResolvedValue({});
      vi.spyOn(NotificationsService, 'notifyLeadAssigned').mockResolvedValue({});

      const mockRpcDb = {
        rpc: vi.fn().mockResolvedValue({
          data: {
            success: true,
            status: 'ASSIGNED',
            lead_id: 99,
            responsible_user_id: 10
          },
          error: null
        })
      };
      getServiceDB.mockReturnValue(mockRpcDb);
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        id: 99,
        responsible_user_id: 10
      });

      const assignedWithRpc = await LeadsRepository.assignManager(99, 10, 'RPC Assignment', 1);
      expect(assignedWithRpc.responsible_user_id).toBe(10);
      expect(mockRpcDb.rpc).toHaveBeenCalledWith('fn_assign_lead_atomic', expect.objectContaining({
        p_lead_id: 99,
        p_target_user_id: 10
      }));

      // 2. With RPC missing (not yet migrated) -> falls back to transactional JS without error
      const mockMissingRpcDb = {
        rpc: vi.fn().mockRejectedValue(new Error('function fn_assign_lead_atomic does not exist')),
        from: vi.fn((table) => {
          if (table === 'users') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 10, name: 'Rep 10', is_active: 1, is_sales_rep: true },
                    error: null
                  })
                }))
              }))
            };
          }
          if (table === 'leads') {
            return {
              update: vi.fn(() => ({
                eq: vi.fn().mockResolvedValue({ error: null })
              }))
            };
          }
          if (table === 'lead_assignment_history') {
            return {
              insert: vi.fn().mockResolvedValue({ error: null })
            };
          }
        })
      };
      getServiceDB.mockReturnValue(mockMissingRpcDb);
      getDB.mockReturnValue(mockMissingRpcDb);

      const assignedFallback = await LeadsRepository.assignManager(99, 10, 'Fallback Assignment', 1);
      expect(assignedFallback).toBeDefined();
    });
  });

  // =========================================================================
  // 6. MIGRATION 052 PURITY & SEPARATE LEGACY TASKS FIX VALIDATION
  // =========================================================================
  describe('6. Валидация чистоты миграций и отдельного скрипта исправления задач 54–56', () => {
    it('миграция 052 содержит исключительно DDL и не выполняет скрытого изменения бизнес-данных', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const migPath = path.resolve(__dirname, '../db/migrations/052_harden_tasks_rls_and_multi_instance_safety.sql');
      const migSql = fs.readFileSync(migPath, 'utf8');

      // Zero data modification
      expect(migSql).not.toContain('UPDATE public.tasks');
      expect(migSql).not.toContain('DELETE FROM public.tasks');
      expect(migSql).not.toContain('TRUNCATE');

      // Essential DDL present
      expect(migSql).toContain('ENABLE ROW LEVEL SECURITY');
      expect(migSql).toContain('uq_tasks_open_lead_call');
      expect(migSql).toContain('uq_tasks_open_deal_type');
      expect(migSql).toContain('fn_assign_lead_atomic');
    });

    it('скрипт PHASE3_6_LEGACY_TASKS_54_55_56_FIX содержит жесткие условия проверки и не удаляет задачи', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const fixPath = path.resolve(__dirname, '../../../PHASE3_6_LEGACY_TASKS_54_55_56_FIX.sql');
      const fixSql = fs.readFileSync(fixPath, 'utf8');

      // Targets only 54, 55, 56
      expect(fixSql).toContain('WHERE id IN (54, 55, 56)');
      // Validates task 31 remains intact and OPEN
      expect(fixSql).toContain('WHERE id = 31');
      expect(fixSql).toContain("status = 'OPEN'");
      // Checks deal_id is null
      expect(fixSql).toContain('deal_id IS NOT NULL');
      // Transitions to CANCELLED without DELETE
      expect(fixSql).toContain("status = 'CANCELLED'");
      expect(fixSql).not.toContain('DELETE FROM');
      // Aborts if not exactly 3 rows
      expect(fixSql).toContain('RAISE EXCEPTION');
    });

    it('скрипты отката rollback_051 и rollback_052 не используют DROP TABLE для бизнес-данных', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const rb51Path = path.resolve(__dirname, '../db/migrations/rollback_051_lead_distribution_settings.sql');
      const rb52Path = path.resolve(__dirname, '../db/migrations/rollback_052_harden_tasks_rls_and_multi_instance_safety.sql');
      const rb51Sql = fs.readFileSync(rb51Path, 'utf8');
      const rb52Sql = fs.readFileSync(rb52Path, 'utf8');

      // Rollback 052 must NEVER drop tasks table
      expect(rb52Sql).not.toContain('DROP TABLE');
      expect(rb52Sql).toContain('DISABLE ROW LEVEL SECURITY');

      // Rollback 051 sets enabled = FALSE safely
      expect(rb51Sql).toContain('enabled = FALSE');
    });
  });
});

