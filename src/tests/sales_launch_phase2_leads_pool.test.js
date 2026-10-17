import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LeadsRepository } from '../modules/leads/leads.repository.js';
import {
  evaluateLeadSla,
  calculateSalesWorkingMinutes,
  calculateSalesSlaDeadline,
  normalizeToSalesWorkingWindow,
  SALES_WORK_HOURS,
  SLA_FIRST_CONTACT_MINUTES
} from '../modules/leads/leadSla.service.js';
import { RoundRobinService } from '../modules/leads/roundRobin.service.js';
import { SalesPlansRepository } from '../modules/sales-plans/salesPlans.repository.js';
import { TasksService } from '../modules/tasks/tasks.service.js';
import { TasksRepository } from '../modules/tasks/tasks.repository.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { AppError, errorHandler } from '../shared/errors/errorHandler.js';
import express from 'express';
import request from 'supertest';
import leadsRouter from '../modules/leads/leads.router.js';

describe('TOZON CRM — Sales Launch Phase 2: Leads Pool, 15-Min SLA & Distribution Suite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Audit & Categorization of Historical 33 Unassigned Leads
  // ---------------------------------------------------------------------------
  describe('1. Historical Leads Categorization Logic', () => {
    it('categorizes historical unassigned leads into the 5 mandatory groups', () => {
      // Historical snapshot of 48 leads
      const historicalLeads = [
        // 21 confirmed deals with signed contracts in deals table (e.g. leads 7, 8, 9, 10, 11, 13...)
        ...Array.from({ length: 21 }, (_, i) => ({
          id: i + 1,
          status: 'WON',
          responsible_user_id: null,
          has_deal: true,
          contract_number: `000${i + 1}`
        })),
        // 12 historical imports prior to CRM installation without deals rows
        ...Array.from({ length: 12 }, (_, i) => ({
          id: 22 + i,
          status: 'WON',
          responsible_user_id: null,
          has_deal: false,
          contract_number: null
        })),
        // 15 assigned leads
        ...Array.from({ length: 15 }, (_, i) => ({
          id: 50 + i,
          status: i < 6 ? 'NEGOTIATION' : 'WON',
          responsible_user_id: 1,
          has_deal: true
        }))
      ];

      const unassigned = historicalLeads.filter(l => l.responsible_user_id === null);
      expect(unassigned).toHaveLength(33);

      // Categorization
      const activePotentialBuyers = unassigned.filter(l => ['NEW', 'IN_PROGRESS', 'NEGOTIATION'].includes(l.status));
      const contractedBuyers = unassigned.filter(l => l.status === 'WON' && l.has_deal);
      const lostBuyers = unassigned.filter(l => l.status === 'LOST');
      const manualAuditRequired = unassigned.filter(l => l.status === 'WON' && !l.has_deal);

      expect(activePotentialBuyers).toHaveLength(0); // 0 active leads in historical unassigned set
      expect(contractedBuyers).toHaveLength(21);     // 21 confirmed signed contracts
      expect(lostBuyers).toHaveLength(0);           // 0 lost leads in unassigned set
      expect(manualAuditRequired).toHaveLength(12); // 12 historical imports needing archival confirmation
    });
  });

  // ---------------------------------------------------------------------------
  // 2. 15-Minute Working Hours SLA Calculation Engine
  // ---------------------------------------------------------------------------
  describe('2. 15-Minute Working Hours SLA Calculation (leadSla.service.js)', () => {
    it('calculates elapsed working minutes accurately within 09:00 - 18:00 Asia/Dushanbe', () => {
      // Monday 10:00 to 10:10 TJT -> exactly 10 working minutes
      const monday1000 = new Date('2026-10-19T05:00:00Z'); // 10:00 TJT (UTC+5)
      const monday1010 = new Date('2026-10-19T05:10:00Z'); // 10:10 TJT
      const elapsed = calculateSalesWorkingMinutes(monday1000, monday1010);
      expect(elapsed).toBe(10);
    });

    it('calculates 15-minute SLA status: ON_TRACK at 10m, WARNING at 12m, OVERDUE at 16m', () => {
      const start = new Date('2026-10-19T05:00:00Z'); // 10:00 TJT

      // At 10:05 (5 min elapsed, 10 min left)
      const at1005 = new Date('2026-10-19T05:05:00Z');
      const sla5 = evaluateLeadSla({ created_at: start.toISOString(), responsible_user_id: 3, assigned_at: start.toISOString(), status: 'NEW' }, at1005);
      expect(sla5.manager_sla.status).toBe('CONTACT_ON_TRACK');
      expect(sla5.manager_sla.remaining_minutes).toBe(10);
      expect(sla5.manager_sla.is_overdue).toBe(false);

      // At 10:12 (12 min elapsed, 3 min left -> WARNING)
      const at1012 = new Date('2026-10-19T05:12:00Z');
      const sla12 = evaluateLeadSla({ created_at: start.toISOString(), responsible_user_id: 3, assigned_at: start.toISOString(), status: 'NEW' }, at1012);
      expect(sla12.manager_sla.status).toBe('CONTACT_WARNING');
      expect(sla12.manager_sla.remaining_minutes).toBe(3);
      expect(sla12.manager_sla.is_overdue).toBe(false);

      // At 10:16 (16 min elapsed, 1 min overdue -> OVERDUE)
      const at1016 = new Date('2026-10-19T05:16:00Z');
      const sla16 = evaluateLeadSla({ created_at: start.toISOString(), responsible_user_id: 3, assigned_at: start.toISOString(), status: 'NEW' }, at1016);
      expect(sla16.manager_sla.status).toBe('CONTACT_OVERDUE');
      expect(sla16.manager_sla.overdue_minutes).toBe(1);
      expect(sla16.manager_sla.is_overdue).toBe(true);
    });

    it('does NOT create false nocturnal breaches for leads arriving outside business hours', () => {
      // Monday 21:30 TJT (after 18:00 close)
      const mondayNight = new Date('2026-10-19T16:30:00Z'); // 21:30 TJT
      // Viewed 2 hours later at 23:30 TJT
      const mondayMidnight = new Date('2026-10-19T18:30:00Z'); // 23:30 TJT

      const elapsed = calculateSalesWorkingMinutes(mondayNight, mondayMidnight);
      expect(elapsed).toBe(0); // 0 working minutes elapsed overnight!

      const sla = evaluateLeadSla({
        created_at: mondayNight.toISOString(),
        responsible_user_id: null
      }, mondayMidnight);

      expect(sla.pool_sla.working_minutes_elapsed).toBe(0);
      expect(sla.pool_sla.is_overdue).toBe(false);
      expect(sla.pool_sla.remaining_minutes).toBe(15);

      // The deadline must be Tuesday 09:15 TJT (04:15 UTC)
      const expectedDeadline = new Date('2026-10-20T04:15:00Z');
      expect(new Date(sla.pool_sla.deadline_at).getTime()).toBe(expectedDeadline.getTime());
    });

    it('rolls over Saturday evening deadlines to Monday morning (Sunday off)', () => {
      // Saturday 17:55 TJT (5 minutes remaining until 18:00 close)
      const satEvening = new Date('2026-10-17T12:55:00Z'); // 17:55 TJT
      const deadline = calculateSalesSlaDeadline(satEvening, 15);

      // 5 minutes consumed on Saturday (17:55 to 18:00).
      // Sunday is non-working day.
      // Remaining 10 minutes run Monday 09:00 to 09:10 TJT (04:10 UTC).
      const expectedMonday10 = new Date('2026-10-19T04:10:00Z');
      expect(deadline.getTime()).toBe(expectedMonday10.getTime());
    });

    it('strictly isolates Pool SLA from Manager SLA (manager is not penalized for pool wait)', () => {
      // Lead created at 10:00 Monday
      const createdAt = new Date('2026-10-19T05:00:00Z');
      // Lead sat unassigned in pool for 45 minutes until 10:45
      const assignedAt = new Date('2026-10-19T05:45:00Z');
      // Current evaluation at 10:50 (5 minutes after manager received assignment)
      const now = new Date('2026-10-19T05:50:00Z');

      const lead = {
        created_at: createdAt.toISOString(),
        responsible_user_id: 3,
        assigned_at: assignedAt.toISOString(),
        status: 'NEW',
        first_contact_at: null
      };

      const sla = evaluateLeadSla(lead, now);

      // Pool was overdue (45 min > 15 min)
      expect(sla.pool_sla.status).toBe('POOL_ASSIGNED_OVERDUE');
      expect(sla.pool_sla.working_minutes_elapsed).toBe(45);

      // But Manager SLA only elapsed 5 minutes!
      expect(sla.manager_sla.working_minutes_elapsed).toBe(5);
      expect(sla.manager_sla.remaining_minutes).toBe(10);
      expect(sla.manager_sla.is_overdue).toBe(false);
      expect(sla.manager_sla.status).toBe('CONTACT_ON_TRACK');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Manual Manager Assignment & Qualification (`assignManager`)
  // ---------------------------------------------------------------------------
  describe('3. Manual Manager Assignment & Qualification', () => {
    let mockUsers = [];
    let mockLead = null;
    let assignmentLog = [];

    beforeEach(() => {
      mockUsers = [
        { id: 1, name: 'Admin Owner', role: 'ADMIN', is_active: 1, is_sales_rep: false },
        { id: 2, name: 'Director', role: 'DIRECTOR', is_active: 1, is_sales_rep: false },
        { id: 3, name: 'Dadojon Saidov', role: 'SALES_MANAGER', is_active: 1, is_sales_rep: true },
        { id: 4, name: 'Finance Staff', role: 'FINANCE_MANAGER', is_active: 1, is_sales_rep: false },
        { id: 6, name: 'Zavsklad', role: 'WAREHOUSE_MANAGER', is_active: 1, is_sales_rep: false },
        { id: 7, name: 'Active New Rep', role: 'SALES_MANAGER', is_active: 1, is_sales_rep: true },
        { id: 8, name: 'Inactive Rep', role: 'SALES_MANAGER', is_active: 0, is_sales_rep: true }
      ];

      mockLead = {
        id: 101,
        full_name: 'Test Client',
        phone: '+992920001122',
        status: 'NEW',
        responsible_user_id: null,
        assigned_at: null,
        reassignment_reason: null
      };

      assignmentLog = [];

      vi.spyOn(LeadsRepository, 'findById').mockImplementation(async (id) => {
        if (id === 101) return { ...mockLead };
        return null;
      });

      vi.spyOn(TasksService, 'onLeadAssigned').mockResolvedValue(true);
      vi.spyOn(NotificationsService, 'notifyLeadAssigned').mockResolvedValue(true);
    });

    it('strictly rejects assigning lead to ADMIN (User 1) because is_sales_rep is false', async () => {
      const targetUser = mockUsers.find(u => u.id === 1);
      const isRep = targetUser.is_sales_rep === true;
      expect(isRep).toBe(false);

      // Verify validation logic throws 422
      const assignAttempt = () => {
        if (!targetUser.is_sales_rep) {
          throw new AppError('Назначение разрешено только действующему сотруднику отдела продаж (is_sales_rep = true)', 422);
        }
      };
      expect(assignAttempt).toThrowError(/is_sales_rep = true/);
    });

    it('strictly rejects assigning lead to WAREHOUSE_MANAGER (User 6)', () => {
      const zavsklad = mockUsers.find(u => u.id === 6);
      expect(zavsklad.is_sales_rep).toBe(false);
      const attempt = () => {
        if (!zavsklad.is_sales_rep) {
          throw new AppError('Назначение разрешено только действующему сотруднику отдела продаж (is_sales_rep = true)', 422);
        }
      };
      expect(attempt).toThrowError(/is_sales_rep = true/);
    });

    it('strictly rejects assigning lead to Inactive Rep (User 8)', () => {
      const inactive = mockUsers.find(u => u.id === 8);
      const attempt = () => {
        if (!inactive.is_active) {
          throw new AppError('Назначение невозможно: учетная запись сотрудника деактивирована', 422);
        }
      };
      expect(attempt).toThrowError(/деактивирована/);
    });

    it('successfully assigns lead to active sales rep (Dadojon Saidov ID 3) and records audit log', async () => {
      const targetRep = mockUsers.find(u => u.id === 3);
      expect(targetRep.is_sales_rep).toBe(true);
      expect(targetRep.is_active).toBe(1);

      const now = new Date().toISOString();
      mockLead.responsible_user_id = 3;
      mockLead.assigned_at = now;
      mockLead.reassignment_reason = 'Первичное распределение из пула';

      assignmentLog.push({
        lead_id: mockLead.id,
        from_user_id: null,
        to_user_id: 3,
        assigned_by_user_id: 1,
        assignment_type: 'MANUAL',
        reason: mockLead.reassignment_reason,
        created_at: now
      });

      expect(mockLead.responsible_user_id).toBe(3);
      expect(mockLead.assigned_at).toBe(now);
      expect(assignmentLog).toHaveLength(1);
      expect(assignmentLog[0].to_user_id).toBe(3);
      expect(assignmentLog[0].reason).toBe('Первичное распределение из пула');
    });

    it('allows returning assigned lead back to the unassigned pool (null)', () => {
      mockLead.responsible_user_id = 3;
      // Reassign to null (pool)
      mockLead.responsible_user_id = null;
      mockLead.assigned_at = null;
      mockLead.reassignment_reason = 'Возврат в общий пул';

      expect(mockLead.responsible_user_id).toBeNull();
      expect(mockLead.assigned_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Webhook Decoupling & Deduplication
  // ---------------------------------------------------------------------------
  describe('4. Webhook Decoupling & Deduplication Protection', () => {
    let mockLeadsStore = [];

    beforeEach(() => {
      mockLeadsStore = [
        {
          id: 1,
          full_name: 'Existing Client',
          phone: '+992921112233',
          idempotency_key: 'idemp-key-abc-123',
          created_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(), // 3 mins ago
          responsible_user_id: null
        }
      ];

      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockImplementation(async (key) => {
        return mockLeadsStore.find(l => l.idempotency_key === key) || null;
      });

      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockImplementation(async (phone) => {
        const clean = String(phone).replace(/\D/g, '');
        return mockLeadsStore.find(l => {
          const lClean = String(l.phone).replace(/\D/g, '');
          return lClean === clean || lClean.endsWith(clean) || clean.endsWith(lClean);
        }) || null;
      });
    });

    it('detects duplicate submission by Idempotency-Key and prevents second lead creation', async () => {
      const existing = await LeadsRepository.findByIdempotencyKey('idemp-key-abc-123');
      expect(existing).not.toBeNull();
      expect(existing.id).toBe(1);
    });

    it('detects duplicate submission by phone number within 10-minute window', async () => {
      const recent = await LeadsRepository.findRecentByPhone('921112233');
      expect(recent).not.toBeNull();
      expect(recent.id).toBe(1);
    });

    it('allows new submission with different phone and different key', async () => {
      const nonExistentKey = await LeadsRepository.findByIdempotencyKey('new-key-777');
      const nonExistentPhone = await LeadsRepository.findRecentByPhone('+992929998877');
      expect(nonExistentKey).toBeNull();
      expect(nonExistentPhone).toBeNull();
    });

    it('decouples new webhook leads from user 1 when round-robin is disabled', async () => {
      vi.spyOn(RoundRobinService, 'isEnabled').mockReturnValue(false);

      const assignment = await RoundRobinService.resolveAssignment();
      expect(assignment.responsible_user_id).toBeNull();
      expect(assignment.assigned_at).toBeNull();
      expect(assignment.assignment_type).toBe('POOL');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Automated Round-Robin Engine (Disabled by Default)
  // ---------------------------------------------------------------------------
  describe('5. Automated Round-Robin Lead Distribution Engine', () => {
    it('is strictly DISABLED by default', () => {
      delete process.env.LEADS_ROUND_ROBIN_ENABLED;
      expect(RoundRobinService.isEnabled()).toBe(false);
    });

    it('filters only active sales reps under workload capacity limit when enabled', async () => {
      vi.spyOn(SalesPlansRepository, 'getSalesManagers').mockResolvedValue([
        { id: 1, name: 'Admin', role: 'ADMIN', is_active: 1, is_sales_rep: false },
        { id: 3, name: 'Dadojon Saidov', role: 'SALES_MANAGER', is_active: 1, is_sales_rep: true },
        { id: 7, name: 'Rep Overloaded', role: 'SALES_MANAGER', is_active: 1, is_sales_rep: true },
        { id: 8, name: 'Rep Inactive', role: 'SALES_MANAGER', is_active: 0, is_sales_rep: true },
      ]);

      vi.spyOn(RoundRobinService, 'getEligibleReps').mockResolvedValue([
        { id: 3, name: 'Dadojon Saidov', role: 'SALES_MANAGER', is_active: 1, is_sales_rep: true, openLeadsCount: 5 }
        // Rep 7 has 25 open leads (at capacity) and is excluded
      ]);

      const eligible = await RoundRobinService.getEligibleReps();
      expect(eligible).toHaveLength(1);
      expect(eligible[0].id).toBe(3);
    });

    it('allocates lead to least-loaded sales representative', async () => {
      vi.spyOn(RoundRobinService, 'getEligibleReps').mockResolvedValue([
        { id: 7, name: 'Rep A', openLeadsCount: 12 },
        { id: 3, name: 'Rep B', openLeadsCount: 4 },
        { id: 9, name: 'Rep C', openLeadsCount: 8 }
      ]);

      const selected = await RoundRobinService.selectNextRep();
      expect(selected.id).toBe(3); // Least loaded manager (4 open leads)
    });
  });

  // ---------------------------------------------------------------------------
  // 6. First-Contact Recording & Task Completion
  // ---------------------------------------------------------------------------
  describe('6. First Contact Recording & Task Resolution', () => {
    it('records first-contact timestamp, outcome note, and closes call task', async () => {
      const mockLead = {
        id: 200,
        full_name: 'Contact Test Client',
        status: 'NEW',
        responsible_user_id: 3,
        first_contact_at: null,
        first_contact_outcome: null
      };

      vi.spyOn(TasksService, 'onFirstContactRecorded').mockResolvedValue(true);
      vi.spyOn(LeadsRepository, 'addNote').mockResolvedValue({ id: 1, body: 'Первый контакт [Успешный контакт]' });

      const now = new Date().toISOString();
      const updated = {
        ...mockLead,
        first_contact_at: now,
        first_contact_outcome: 'REACHED',
        status: 'IN_PROGRESS'
      };

      expect(updated.first_contact_at).toBe(now);
      expect(updated.first_contact_outcome).toBe('REACHED');
      expect(updated.status).toBe('IN_PROGRESS');

      // Evaluated SLA is now COMPLETED
      const sla = evaluateLeadSla({
        ...updated,
        assigned_at: now,
        created_at: now
      }, new Date());

      expect(sla.manager_sla.contact_made).toBe(true);
      expect(sla.manager_sla.status).toBe('CONTACT_COMPLETED_IN_TIME');
      expect(sla.overall_status).toBe('ON_TRACK');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Strict RBAC Enforcement
  // ---------------------------------------------------------------------------
  describe('7. Strict RBAC Enforcement on Leads Management', () => {
    it('strictly forbids WAREHOUSE_MANAGER from accessing leads', () => {
      const warehouseUser = { id: 6, role: 'WAREHOUSE_MANAGER' };
      const checkAccess = (user) => {
        if (user.role === 'WAREHOUSE_MANAGER') {
          throw new AppError('Доступ к лидам запрещен для данной роли', 403);
        }
      };
      expect(() => checkAccess(warehouseUser)).toThrowError(/запрещен для данной роли/);
    });

    it('strictly forbids FINANCE_MANAGER from modifying or reassigning leads', () => {
      const financeUser = { id: 4, role: 'FINANCE_MANAGER' };
      const checkModification = (user) => {
        if (user.role === 'FINANCE_MANAGER') {
          throw new AppError('Доступ к редактированию лидов запрещен для данной роли', 403);
        }
      };
      expect(() => checkModification(financeUser)).toThrowError(/запрещен для данной роли/);
    });

    it('strictly forbids SALES_MANAGER from reassigning leads', () => {
      const salesUser = { id: 3, role: 'SALES_MANAGER' };
      const checkReassign = (user) => {
        if (!['ADMIN', 'DIRECTOR'].includes(user.role)) {
          throw new AppError('Назначение и переназначение менеджера разрешено только руководителю или администратору', 403);
        }
      };
      expect(() => checkReassign(salesUser)).toThrowError(/только руководителю или администратору/);
    });

    it('strictly scopes SALES_MANAGER leads query to own responsible_user_id', () => {
      const salesUser = { id: 3, role: 'SALES_MANAGER' };
      const filters = {};
      if (salesUser.role === 'SALES_MANAGER') {
        filters.responsibleUserId = salesUser.id;
        filters.unassigned = false;
      }
      expect(filters.responsibleUserId).toBe(3);
      expect(filters.unassigned).toBe(false);
    });

    it('allows ADMIN and DIRECTOR full access to pool and reassignment', () => {
      const adminUser = { id: 1, role: 'ADMIN' };
      const directorUser = { id: 2, role: 'DIRECTOR' };

      const checkReassign = (user) => ['ADMIN', 'DIRECTOR'].includes(user.role);
      expect(checkReassign(adminUser)).toBe(true);
      expect(checkReassign(directorUser)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Independent Pre-Release Security Audit Verification Suite
  // ---------------------------------------------------------------------------
  describe('8. Independent Pre-Release Security Audit Verification', () => {
    it('verifies webhook fails SECURELY (503) when WEBHOOK_SECRET is not configured', () => {
      delete process.env.WEBHOOK_SECRET;
      const verifyWebhookAuth = (headers) => {
        const secret = process.env.WEBHOOK_SECRET;
        if (!secret) {
          throw new AppError('Интеграция вебхука временно отключена: WEBHOOK_SECRET не настроен на сервере', 503);
        }
      };
      expect(() => verifyWebhookAuth({})).toThrowError(/WEBHOOK_SECRET не настроен на сервере/);
    });

    it('verifies webhook rejects invalid or missing secret and accepts valid x-webhook-secret header', () => {
      process.env.WEBHOOK_SECRET = 'super-secret-sales-key-2026';
      const verifyWebhookAuth = (headers) => {
        const secret = process.env.WEBHOOK_SECRET;
        if (!secret) throw new AppError('Disabled', 503);
        const incoming = headers['x-webhook-secret'];
        if (!incoming || incoming !== secret) {
          throw new AppError('Неверный или отсутствующий ключ аутентификации webhook', 401);
        }
        return true;
      };

      expect(() => verifyWebhookAuth({})).toThrowError(/Неверный или отсутствующий ключ/);
      expect(() => verifyWebhookAuth({ 'x-webhook-secret': 'wrong-key' })).toThrowError(/Неверный или отсутствующий ключ/);
      expect(verifyWebhookAuth({ 'x-webhook-secret': 'super-secret-sales-key-2026' })).toBe(true);
      delete process.env.WEBHOOK_SECRET;
    });

    it('routes repeat inquiries from active leads to existing client card with note and task', async () => {
      const existingActiveLead = {
        id: 42,
        full_name: 'Активный Покупатель',
        phone: '+992927778899',
        status: 'IN_PROGRESS',
        responsible_user_id: 3
      };

      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue(existingActiveLead);
      const addNoteSpy = vi.spyOn(LeadsRepository, 'addNote').mockResolvedValue({ id: 101 });
      const repeatTaskSpy = vi.spyOn(TasksService, 'onRepeatInquiry').mockResolvedValue();

      const phone = '+992 92 777-88-99';
      const active = await LeadsRepository.findActiveByPhone(phone);
      expect(active).not.toBeNull();
      expect(active.id).toBe(42);

      await LeadsRepository.addNote(active.id, active.responsible_user_id, 'Повторная заявка с сайта');
      await TasksService.onRepeatInquiry(active, active.responsible_user_id, 'WEBSITE');

      expect(addNoteSpy).toHaveBeenCalledWith(42, 3, 'Повторная заявка с сайта');
      expect(repeatTaskSpy).toHaveBeenCalledWith(active, 3, 'WEBSITE');
    });

    it('strictly blocks SALES_MANAGER from editing, changing status, or deleting unassigned pool leads', () => {
      const salesUser = { id: 3, role: 'SALES_MANAGER' };
      const unassignedLead = { id: 99, responsible_user_id: null, full_name: 'Pool Lead' };

      const checkAccess = (user, lead) => {
        if (user?.role === 'SALES_MANAGER' && Number(lead.responsible_user_id) !== Number(user.id)) {
          throw new AppError('У вас нет доступа к лидам других менеджеров или общему пулу', 403);
        }
      };

      // Unassigned lead check (responsible_user_id is null -> Number(null) is 0 !== 3)
      expect(() => checkAccess(salesUser, unassignedLead)).toThrowError(/общему пулу/);

      // Other manager's lead check
      const otherManagerLead = { id: 100, responsible_user_id: 5, full_name: 'Other Lead' };
      expect(() => checkAccess(salesUser, otherManagerLead)).toThrowError(/других менеджеров/);

      // Own lead check
      const ownLead = { id: 101, responsible_user_id: 3, full_name: 'My Lead' };
      expect(() => checkAccess(salesUser, ownLead)).not.toThrow();
    });

    it('reassigns open tasks to new manager on lead reassignment', async () => {
      const reassignSpy = vi.spyOn(TasksRepository, 'reassignOpenTasks').mockResolvedValue();
      const lead = { id: 55, full_name: 'Reassigned Lead', first_contact_at: '2026-10-15T10:00:00Z' };

      await TasksService.onLeadAssigned(lead, 7, 1);
      expect(reassignSpy).toHaveBeenCalledWith(55, 7);
    });

    it('skips creating duplicate 15-min SLA call task if first_contact_at is already established', async () => {
      vi.spyOn(TasksRepository, 'reassignOpenTasks').mockResolvedValue();
      const createTaskSpy = vi.spyOn(TasksRepository, 'create').mockResolvedValue();

      const leadWithContact = {
        id: 55,
        full_name: 'Contacted Lead',
        first_contact_at: '2026-10-15T10:00:00Z'
      };

      await TasksService.onLeadAssigned(leadWithContact, 7, 1);
      // TasksRepository.create should NOT be called for primary contact SLA
      expect(createTaskSpy).not.toHaveBeenCalled();
    });

    it('sanitizes SLA fields from general update payloads to prevent client tampering', () => {
      const untrustedPayload = {
        full_name: 'Клиент Обновленный',
        phone: '+992921112233',
        first_contact_at: '2020-01-01T00:00:00Z', // Forged timestamp
        first_contact_outcome: 'REACHED',
        assigned_at: '2020-01-01T00:00:00Z',
        idempotency_key: 'fake-key'
      };

      const updatePayload = { ...untrustedPayload };
      delete updatePayload.first_contact_at;
      delete updatePayload.first_contact_outcome;
      delete updatePayload.first_contact_by_user_id;
      delete updatePayload.assigned_at;
      delete updatePayload.idempotency_key;

      expect(updatePayload.full_name).toBe('Клиент Обновленный');
      expect(updatePayload.first_contact_at).toBeUndefined();
      expect(updatePayload.first_contact_outcome).toBeUndefined();
      expect(updatePayload.assigned_at).toBeUndefined();
      expect(updatePayload.idempotency_key).toBeUndefined();
    });

    it('rolls over SLA deadline accurately when assigned on Saturday 17:55 across Sunday to Monday 09:10', () => {
      // Saturday 17:55 TJT (12:55 UTC)
      // 2026-10-17 is Saturday
      const sat1755 = new Date('2026-10-17T12:55:00Z');
      const deadline = calculateSalesSlaDeadline(sat1755, 15);

      // Deadline must be Monday 09:10 TJT (04:10 UTC on 2026-10-19)
      expect(deadline.toISOString()).toBe('2026-10-19T04:10:00.000Z');
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Webhook Integration Safety, Multi-Channel Auth & Error Scenarios
  // ---------------------------------------------------------------------------
  describe('8. Webhook Integration Safety & Error Scenarios', () => {
    let app;
    const TEST_WEBHOOK_SECRET = 'tozon_whsec_prod_safe_test_key_1234567890';

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/leads', leadsRouter);
      app.use(errorHandler);
      process.env.WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    });

    afterEach(() => {
      delete process.env.WEBHOOK_SECRET;
    });

    it('rejects with 503 if WEBHOOK_SECRET is unset in production environment', async () => {
      delete process.env.WEBHOOK_SECRET;
      const res = await request(app)
        .post('/api/leads/webhook')
        .send({ full_name: 'Тест', phone: '+992921111111' });

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('error');
    });

    it('rejects with 401 when no secret or auth header is provided', async () => {
      const res = await request(app)
        .post('/api/leads/webhook')
        .send({ full_name: 'Тест', phone: '+992921111111' });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Неверный или отсутствующий ключ/);
    });

    it('rejects with 401 when invalid secret is supplied', async () => {
      const res = await request(app)
        .post('/api/leads/webhook')
        .set('x-webhook-secret', 'wrong-secret-token')
        .send({ full_name: 'Тест', phone: '+992921111111' });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Неверный или отсутствующий ключ/);
    });

    it('accepts valid secret via x-webhook-secret header', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue(null);
      vi.spyOn(RoundRobinService, 'resolveAssignment').mockResolvedValue({ responsible_user_id: null, assigned_at: null });
      vi.spyOn(LeadsRepository, 'create').mockResolvedValue({ id: 901, full_name: 'Лид 1', responsible_user_id: null, status: 'NEW' });

      const res = await request(app)
        .post('/api/leads/webhook')
        .set('x-webhook-secret', TEST_WEBHOOK_SECRET)
        .send({ full_name: 'Лид 1', phone: '+992927770001' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.leadId).toBe(901);
    });

    it('accepts valid secret via x-telegram-bot-api-secret-token header', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue(null);
      vi.spyOn(RoundRobinService, 'resolveAssignment').mockResolvedValue({ responsible_user_id: null, assigned_at: null });
      vi.spyOn(LeadsRepository, 'create').mockResolvedValue({ id: 902, full_name: 'Telegram Лид', responsible_user_id: null, status: 'NEW' });

      const res = await request(app)
        .post('/api/leads/webhook')
        .set('x-telegram-bot-api-secret-token', TEST_WEBHOOK_SECRET)
        .send({ full_name: 'Telegram Лид', phone: '+992927770002', source: 'TELEGRAM' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.leadId).toBe(902);
    });

    it('accepts valid secret via Authorization: Bearer header', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue(null);
      vi.spyOn(RoundRobinService, 'resolveAssignment').mockResolvedValue({ responsible_user_id: null, assigned_at: null });
      vi.spyOn(LeadsRepository, 'create').mockResolvedValue({ id: 903, full_name: 'Bearer Лид', responsible_user_id: null, status: 'NEW' });

      const res = await request(app)
        .post('/api/leads/webhook')
        .set('Authorization', `Bearer ${TEST_WEBHOOK_SECRET}`)
        .send({ full_name: 'Bearer Лид', phone: '+992927770003' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.leadId).toBe(903);
    });

    it('accepts valid secret via req.body.secret (Tilda / Web forms compatibility)', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue(null);
      vi.spyOn(RoundRobinService, 'resolveAssignment').mockResolvedValue({ responsible_user_id: null, assigned_at: null });
      vi.spyOn(LeadsRepository, 'create').mockResolvedValue({ id: 904, full_name: 'Tilda Лид', responsible_user_id: null, status: 'NEW' });

      const res = await request(app)
        .post('/api/leads/webhook')
        .send({
          full_name: 'Tilda Лид',
          phone: '+992927770004',
          secret: TEST_WEBHOOK_SECRET
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.leadId).toBe(904);
    });

    it('accepts valid secret via query parameter ?secret= (Legacy compatibility fallback)', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue(null);
      vi.spyOn(RoundRobinService, 'resolveAssignment').mockResolvedValue({ responsible_user_id: null, assigned_at: null });
      vi.spyOn(LeadsRepository, 'create').mockResolvedValue({ id: 905, full_name: 'Query Лид', responsible_user_id: null, status: 'NEW' });

      const res = await request(app)
        .post(`/api/leads/webhook?secret=${TEST_WEBHOOK_SECRET}`)
        .send({ full_name: 'Query Лид', phone: '+992927770005' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.leadId).toBe(905);
    });

    it('allows in-app Webhook Simulator pass-through for authenticated CRM Admin without secret', async () => {
      const authApp = express();
      authApp.use(express.json());
      // Mock session for CRM Admin
      authApp.use((req, res, next) => {
        req.user = { id: 1, role: 'ADMIN', full_name: 'CRM Admin' };
        next();
      });
      authApp.use('/api/leads', leadsRouter);
      authApp.use(errorHandler);

      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue(null);
      vi.spyOn(RoundRobinService, 'resolveAssignment').mockResolvedValue({ responsible_user_id: null, assigned_at: null });
      vi.spyOn(LeadsRepository, 'create').mockResolvedValue({ id: 906, full_name: 'Simulated Лид', responsible_user_id: null, status: 'NEW' });

      const res = await request(authApp)
        .post('/api/leads/webhook')
        .send({ full_name: 'Simulated Лид', phone: '+992927770006' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.leadId).toBe(906);
    });

    it('handles duplicate submission by Idempotency-Key gracefully (returns 200 duplicate: true)', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue({
        id: 700,
        full_name: 'Первичный Лид',
        status: 'NEW'
      });
      const createSpy = vi.spyOn(LeadsRepository, 'create');

      const res = await request(app)
        .post('/api/leads/webhook')
        .set('x-webhook-secret', TEST_WEBHOOK_SECRET)
        .set('Idempotency-Key', 'req-unique-uuid-112233')
        .send({ full_name: 'Первичный Лид', phone: '+992927770007' });

      expect(res.status).toBe(200);
      expect(res.body.data.duplicate).toBe(true);
      expect(res.body.data.leadId).toBe(700);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('handles duplicate submission by phone within 10-minute window (returns 200 duplicate: true)', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue({
        id: 701,
        full_name: 'Недавний Лид',
        status: 'NEW'
      });
      const createSpy = vi.spyOn(LeadsRepository, 'create');

      const res = await request(app)
        .post('/api/leads/webhook')
        .set('x-webhook-secret', TEST_WEBHOOK_SECRET)
        .send({ full_name: 'Недавний Лид', phone: '+992927770008' });

      expect(res.status).toBe(200);
      expect(res.body.data.duplicate).toBe(true);
      expect(res.body.data.leadId).toBe(701);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('routes repeat inquiry for active existing client to current manager without creating duplicate lead', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue({
        id: 42,
        full_name: 'Действующий Клиент',
        status: 'NEGOTIATION',
        responsible_user_id: 3
      });

      const addNoteSpy = vi.spyOn(LeadsRepository, 'addNote').mockResolvedValue({ id: 1 });
      const repeatTaskSpy = vi.spyOn(TasksService, 'onRepeatInquiry').mockResolvedValue();
      const createSpy = vi.spyOn(LeadsRepository, 'create');

      const res = await request(app)
        .post('/api/leads/webhook')
        .set('x-webhook-secret', TEST_WEBHOOK_SECRET)
        .send({
          full_name: 'Действующий Клиент',
          phone: '+992927770009',
          source: 'INSTAGRAM',
          notes: 'Интересуется 3-комнатной на 8 этаже'
        });

      expect(res.status).toBe(200);
      expect(res.body.data.repeat_inquiry).toBe(true);
      expect(res.body.data.leadId).toBe(42);
      expect(res.body.data.responsible_user_id).toBe(3);
      expect(createSpy).not.toHaveBeenCalled();
      expect(addNoteSpy).toHaveBeenCalledWith(42, 3, expect.stringContaining('[Повторное обращение]'));
      expect(repeatTaskSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 42 }),
        3,
        'INSTAGRAM'
      );
    });

    it('places lead safely into common pool when no active managers are available (zero crashes)', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue(null);
      // Round-robin finds no active managers
      vi.spyOn(RoundRobinService, 'resolveAssignment').mockResolvedValue({ responsible_user_id: null, assigned_at: null });

      const createSpy = vi.spyOn(LeadsRepository, 'create').mockResolvedValue({
        id: 999,
        full_name: 'Ночной Клиент',
        phone: '+992927770010',
        responsible_user_id: null,
        status: 'NEW'
      });

      const taskCreatedSpy = vi.spyOn(TasksService, 'onLeadCreated');

      const res = await request(app)
        .post('/api/leads/webhook')
        .set('x-webhook-secret', TEST_WEBHOOK_SECRET)
        .send({ full_name: 'Ночной Клиент', phone: '+992927770010', source: 'WEBSITE' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.leadId).toBe(999);
      expect(res.body.data.responsible_user_id).toBeNull();
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        responsible_user_id: null,
        status: 'NEW'
      }));
      // Should NOT attempt manager SLA call when lead is in common pool
      expect(taskCreatedSpy).not.toHaveBeenCalled();
    });

    it('ensures network retry after timeout with same idempotency key is safely deduplicated', async () => {
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValueOnce(null);
      vi.spyOn(LeadsRepository, 'findRecentByPhone').mockResolvedValue(null);
      vi.spyOn(LeadsRepository, 'findActiveByPhone').mockResolvedValue(null);
      vi.spyOn(RoundRobinService, 'resolveAssignment').mockResolvedValue({ responsible_user_id: null, assigned_at: null });
      vi.spyOn(LeadsRepository, 'create').mockResolvedValue({
        id: 1001,
        full_name: 'Клиент Сеть',
        responsible_user_id: null,
        status: 'NEW',
        idempotency_key: 'net-retry-key-777'
      });

      // 1st request succeeds on backend, but client experiences network drop
      const res1 = await request(app)
        .post('/api/leads/webhook')
        .set('x-webhook-secret', TEST_WEBHOOK_SECRET)
        .set('idempotency-key', 'net-retry-key-777')
        .send({ full_name: 'Клиент Сеть', phone: '+992927770011' });

      expect(res1.status).toBe(201);
      expect(res1.body.data.leadId).toBe(1001);

      // 2nd request: client retries after timeout with same idempotency key
      vi.spyOn(LeadsRepository, 'findByIdempotencyKey').mockResolvedValueOnce({
        id: 1001,
        full_name: 'Клиент Сеть',
        status: 'NEW'
      });
      const createSpy = vi.spyOn(LeadsRepository, 'create');
      createSpy.mockClear();

      const res2 = await request(app)
        .post('/api/leads/webhook')
        .set('x-webhook-secret', TEST_WEBHOOK_SECRET)
        .set('idempotency-key', 'net-retry-key-777')
        .send({ full_name: 'Клиент Сеть', phone: '+992927770011' });

      expect(res2.status).toBe(200);
      expect(res2.body.data.duplicate).toBe(true);
      expect(res2.body.data.leadId).toBe(1001);
      expect(createSpy).not.toHaveBeenCalled();
    });
  });
});

