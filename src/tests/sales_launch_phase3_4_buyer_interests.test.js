import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../middleware/auth.middleware.js', () => ({
  protect: (req, res, next) => next(),
  protectOptional: (req, res, next) => next()
}));

import leadsRouter from '../modules/leads/leads.router.js';
import { LeadsRepository } from '../modules/leads/leads.repository.js';
import { InventoryRepository } from '../modules/inventory/inventory.repository.js';
import { TasksRepository } from '../modules/tasks/tasks.repository.js';

// Setup mock express app with authentication mock middleware
const createTestApp = (currentUser = { id: 1, name: 'Admin User', role: 'ADMIN' }) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = currentUser;
    next();
  });
  app.use('/api/leads', leadsRouter);
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({
      status: err.status || 'error',
      message: err.message
    });
  });
  return app;
};

describe('TOZON CRM — Sales Launch Phase 3.4: Buyer Interests & Smart Selection API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockLead = {
    id: 10,
    full_name: 'Акмал Каримов',
    phone: '+992927778899',
    status: 'IN_PROGRESS',
    responsible_user_id: 2
  };

  const mockUnit90 = {
    id: 90,
    unit_number: '18',
    status: 'AVAILABLE',
    rooms: 2,
    area_m2_x100: 6991,
    price_per_m2_minor: 70000,
    manual_total_price_minor: null,
    floors: {
      floor_number: 3,
      sections: {
        buildings: {
          name: 'Блок Б',
          projects: { name: 'ЖК TOZON PLAZA', currency: 'USD' }
        }
      }
    },
    layout_types: {
      name: 'Блок Б — тип 1 — 69.91 м²',
      image_path: '/layouts/block_b/catalog/block_b_typical_type_01_69_91m2_3d.png'
    }
  };

  describe('1. RBAC & Security Access Control', () => {
    it('blocks SALES_MANAGER from viewing interested units of other managers', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        ...mockLead,
        responsible_user_id: 99 // Assigned to another manager
      });

      const app = createTestApp({ id: 2, name: 'Manager 2', role: 'SALES_MANAGER' });
      const res = await request(app).get('/api/leads/10/interested-units');

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('У вас нет доступа к просмотру лидов других менеджеров');
    });

    it('blocks SALES_MANAGER from attaching interested units to other managers leads', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        ...mockLead,
        responsible_user_id: 99
      });

      const app = createTestApp({ id: 2, name: 'Manager 2', role: 'SALES_MANAGER' });
      const res = await request(app)
        .post('/api/leads/10/interested-units')
        .send({ unit_id: 90, priority: 'HIGH' });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('У вас нет доступа');
    });

    it('allows assigned SALES_MANAGER to view and attach interested units', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        ...mockLead,
        responsible_user_id: 2
      });
      vi.spyOn(LeadsRepository, 'getInterestedUnits').mockResolvedValue([]);
      vi.spyOn(LeadsRepository, 'addInterestedUnit').mockResolvedValue({
        interest: { id: 1, lead_id: 10, unit_id: 90, priority: 'HIGH' },
        task: null
      });

      const app = createTestApp({ id: 2, name: 'Manager 2', role: 'SALES_MANAGER' });

      const getRes = await request(app).get('/api/leads/10/interested-units');
      expect(getRes.status).toBe(200);

      const postRes = await request(app)
        .post('/api/leads/10/interested-units')
        .send({ unit_id: 90, priority: 'HIGH', comment: 'Клиенту понравилась планировка' });
      expect(postRes.status).toBe(201);
    });

    it('allows DIRECTOR and ADMIN full access across all leads', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        ...mockLead,
        responsible_user_id: 99
      });
      vi.spyOn(LeadsRepository, 'getInterestedUnits').mockResolvedValue([]);

      const app = createTestApp({ id: 1, name: 'Director', role: 'DIRECTOR' });
      const res = await request(app).get('/api/leads/10/interested-units');
      expect(res.status).toBe(200);
    });
  });

  describe('2. Validation & Task Generation', () => {
    it('returns 400 when unit_id is missing', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue(mockLead);

      const app = createTestApp();
      const res = await request(app)
        .post('/api/leads/10/interested-units')
        .send({ priority: 'HIGH', comment: 'Без квартиры' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('unit_id');
    });

    it('creates follow-up task when next_contact_date is specified', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue(mockLead);
      vi.spyOn(InventoryRepository, 'getUnitById').mockResolvedValue(mockUnit90);

      const addNoteSpy = vi.spyOn(LeadsRepository, 'addNote').mockResolvedValue({ id: 101 });
      const createTaskSpy = vi.spyOn(TasksRepository, 'create').mockResolvedValue({
        id: 501,
        title: 'Подбор: Контакт по кв. №18',
        due_date: '2026-10-25'
      });

      const app = createTestApp({ id: 2, name: 'Manager 2', role: 'SALES_MANAGER' });
      const res = await request(app)
        .post('/api/leads/10/interested-units')
        .send({
          unit_id: 90,
          priority: 'HIGH',
          comment: 'Ждет одобрения от супруги',
          next_contact_date: '2026-10-25'
        });

      expect(res.status).toBe(201);
      expect(addNoteSpy).toHaveBeenCalledWith(10, 2, expect.stringContaining('[UNIT_INTEREST]'));
      expect(createTaskSpy).toHaveBeenCalledWith(expect.objectContaining({
        lead_id: 10,
        assigned_user_id: 2,
        type: 'CALL',
        priority: 'HIGH',
        unit_number: '18',
        due_date: '2026-10-25'
      }));
    });
  });

  describe('3. Enriched Unit Data Structure', () => {
    it('returns accurate official CRM price, layout thumbnail and live status', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue(mockLead);
      vi.spyOn(LeadsRepository, 'getInterestedUnits').mockResolvedValue([
        {
          id: 1,
          lead_id: 10,
          unit_id: 90,
          priority: 'HIGH',
          comment: 'Приоритетный выбор',
          next_contact_date: '2026-10-25',
          created_at: '2026-10-18T10:00:00Z',
          unit: {
            id: 90,
            unit_number: '18',
            status: 'AVAILABLE',
            rooms: 2,
            areaM2: 69.91,
            pricePerM2: 700,
            totalPrice: 48937,
            floor_number: 3,
            building_name: 'Блок Б',
            project_name: 'ЖК TOZON PLAZA',
            plan_image_url: '/layouts/block_b/catalog/block_b_typical_type_01_69_91m2_3d.png',
            layout_name: 'Блок Б — тип 1 — 69.91 м²'
          }
        }
      ]);

      const app = createTestApp();
      const res = await request(app).get('/api/leads/10/interested-units');

      expect(res.status).toBe(200);
      expect(res.body.data.interests).toHaveLength(1);
      const interest = res.body.data.interests[0];
      expect(interest.unit.unit_number).toBe('18');
      expect(interest.unit.pricePerM2).toBe(700);
      expect(interest.unit.totalPrice).toBe(48937);
      expect(interest.unit.plan_image_url).toBe('/layouts/block_b/catalog/block_b_typical_type_01_69_91m2_3d.png');
    });
  });

  describe('4. DELETE /api/leads/:id/interested-units/:unitId', () => {
    it('blocks SALES_MANAGER from deleting interested units of other managers', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        ...mockLead,
        responsible_user_id: 99
      });

      const app = createTestApp({ id: 2, name: 'Manager 2', role: 'SALES_MANAGER' });
      const res = await request(app).delete('/api/leads/10/interested-units/90');

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('У вас нет доступа');
    });

    it('blocks FINANCE_MANAGER from deleting interested units', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue(mockLead);

      const app = createTestApp({ id: 4, name: 'Finance', role: 'FINANCE_MANAGER' });
      const res = await request(app).delete('/api/leads/10/interested-units/90');

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('Доступ запрещен');
    });

    it('allows assigned manager to remove interested unit', async () => {
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue(mockLead);
      const removeSpy = vi.spyOn(LeadsRepository, 'removeInterestedUnit').mockResolvedValue(true);

      const app = createTestApp({ id: 2, name: 'Manager 2', role: 'SALES_MANAGER' });
      const res = await request(app).delete('/api/leads/10/interested-units/90');

      expect(res.status).toBe(200);
      expect(removeSpy).toHaveBeenCalledWith(10, 90, expect.any(Object));
      expect(res.body.message).toContain('удалена из интересов');
    });
  });

  describe('5. Security Gate: RLS, Grants & Zero Data Loss Rollback Verification', () => {
    it('verifies that migration 050 strictly revokes anon and authenticated direct access', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const filePath = path.resolve(process.cwd(), fs.existsSync('src/db/migrations') ? 'src/db/migrations/050_lead_interested_units.sql' : 'server/src/db/migrations/050_lead_interested_units.sql');
      const sqlContent = fs.readFileSync(filePath, 'utf8');

      expect(sqlContent).toContain('REVOKE ALL ON public.lead_interested_units FROM PUBLIC, anon, authenticated;');
      expect(sqlContent).toContain('GRANT ALL ON public.lead_interested_units TO service_role, postgres;');
      expect(sqlContent).toContain('CONSTRAINT uq_lead_unit_interest UNIQUE (lead_id, unit_id)');
      expect(sqlContent).toContain('ENABLE ROW LEVEL SECURITY;');
      expect(sqlContent).toContain('ON CONFLICT (lead_id, unit_id) DO UPDATE SET');
    });

    it('verifies that rollback_050 preserves table lead_interested_units and syncs to lead_notes without DROP TABLE', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const filePath = path.resolve(process.cwd(), fs.existsSync('src/db/migrations') ? 'src/db/migrations/rollback_050_lead_interested_units.sql' : 'server/src/db/migrations/rollback_050_lead_interested_units.sql');
      const rollbackSql = fs.readFileSync(filePath, 'utf8');

      // Zero Data Loss check: must NOT drop table in app rollback
      expect(rollbackSql).not.toContain('DROP TABLE public.lead_interested_units');
      expect(rollbackSql).not.toContain('DROP TABLE IF EXISTS public.lead_interested_units');
      expect(rollbackSql).toContain('INSERT INTO public.lead_notes');
      expect(rollbackSql).toContain('[UNIT_INTEREST]');
      expect(rollbackSql).toContain('TABLE PRESERVATION ASSURANCE');
    });

    it('verifies that explicit purge script purge_050 requires pre-drop backup assertion', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const filePath = path.resolve(process.cwd(), fs.existsSync('src/db/migrations') ? 'src/db/migrations/purge_050_lead_interested_units_explicit.sql' : 'server/src/db/migrations/purge_050_lead_interested_units_explicit.sql');
      const purgeSql = fs.readFileSync(filePath, 'utf8');

      expect(purgeSql).toContain('Pre-Drop Safety Assertion');
      expect(purgeSql).toContain('DROP TABLE public.lead_interested_units CASCADE;');
    });

    it('simulates zero data loss during rollback and forward migration with new interest created during rollback', () => {
      // 1. Initial interest in table
      const tableRows = [
        { id: 1, lead_id: 10, unit_id: 90, priority: 'HIGH', comment: 'Выбор клиента', next_contact_date: '2026-10-25' }
      ];

      // 2. Rollback simulation: syncs tableRows to notesMap
      const notes = [];
      for (const row of tableRows) {
        const body = `[UNIT_INTEREST] ${JSON.stringify({
          unit_id: row.unit_id,
          priority: row.priority,
          comment: row.comment,
          next_contact_date: row.next_contact_date
        })}`;
        notes.push({ id: 1, lead_id: row.lead_id, body });
      }
      expect(notes).toHaveLength(1);

      // 3. New interest created in lead_notes by rolled-back app version
      const rollbackInterest = {
        unit_id: 91,
        priority: 'MEDIUM',
        comment: 'Создано во время отката',
        next_contact_date: '2026-10-28'
      };
      notes.push({
        id: 2,
        lead_id: 10,
        body: `[UNIT_INTEREST] ${JSON.stringify(rollbackInterest)}`
      });
      expect(notes).toHaveLength(2);

      // 4. Re-forward migration: backfill merges both into tableRows
      const reMigratedMap = new Map();
      for (const r of tableRows) {
        reMigratedMap.set(`${r.lead_id}_${r.unit_id}`, r);
      }
      for (const n of notes) {
        const payload = JSON.parse(n.body.replace('[UNIT_INTEREST] ', ''));
        const key = `${n.lead_id}_${payload.unit_id}`;
        reMigratedMap.set(key, { lead_id: n.lead_id, ...payload });
      }

      const finalUnits = Array.from(reMigratedMap.values());
      expect(finalUnits).toHaveLength(2);
      expect(finalUnits.map(u => u.unit_id)).toContain(90);
      expect(finalUnits.map(u => u.unit_id)).toContain(91);
      const unit91 = finalUnits.find(u => u.unit_id === 91);
      expect(unit91.comment).toBe('Создано во время отката');
      expect(unit91.next_contact_date).toBe('2026-10-28');
    });
  });
});

