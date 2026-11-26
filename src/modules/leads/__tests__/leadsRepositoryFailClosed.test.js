import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockUpdate = vi.fn();
const mockRpc = vi.fn();
const mockOnLeadStatusChanged = vi.fn();

vi.mock('../../../db/connection.js', () => ({
  getDB: () => ({
    from: () => ({
      update: mockUpdate,
      select: () => ({ eq: () => ({ maybeSingle: () => ({ data: null }) }) })
    })
  }),
  getServiceDB: () => ({
    rpc: mockRpc,
    from: () => ({ update: mockUpdate })
  })
}));

vi.mock('../../tasks/tasks.service.js', () => ({
  TasksService: {
    onLeadStatusChanged: mockOnLeadStatusChanged,
    onLeadCreated: vi.fn().mockResolvedValue(null),
    onLeadAssigned: vi.fn().mockResolvedValue(null),
    onFirstContactOutcome: vi.fn().mockResolvedValue(null),
    cancelOpenSalesTasks: vi.fn().mockResolvedValue(null)
  }
}));

vi.mock('../../notifications/notifications.service.js', () => ({
  NotificationsService: {
    notifyLeadAssigned: vi.fn().mockResolvedValue(null),
    notifyLeadCreated: vi.fn().mockResolvedValue(null)
  }
}));

vi.mock('../../../middleware/auth.middleware.js', () => ({
  protect: (req, _res, next) => {
    req.user = req._testUser || { id: 1, role: 'DIRECTOR' };
    next();
  },
  protectOptional: (_req, _res, next) => next()
}));

const { LeadsRepository } = await import('../leads.repository.js');
const { default: leadsRouter } = await import('../leads.router.js');

describe('R03 & R03.1: LeadsRepository & Router fail-closed, bypass prevention, and HTTP conflict codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws 503 on RPC error without bypassing concurrency via direct UPDATE', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } });

    await expect(
      LeadsRepository.updateStatus(10, 'IN_PROGRESS', null, null, 1, { expectedVersion: 1 })
    ).rejects.toMatchObject({ statusCode: 503 });

    await expect(
      LeadsRepository.assignManager(10, 2, 'Test', 1, true, 1)
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects direct status/stage mutation in LeadsRepository.update without writing to DB', async () => {
    await expect(LeadsRepository.update(10, { status: 'WON' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(LeadsRepository.update(10, { stage: 'SIGNED' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('blocks PUT/PATCH /api/leads/:id status bypass and avoids duplicate direct UPDATE of responsible_user_id', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/leads', leadsRouter);
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ status: 'error', message: err.message }));

    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
      id: 10, full_name: 'Lead 10', responsible_user_id: 2, stage: 'NEW', status: 'NEW', version: 1
    });

    const bypassPut = await request(app).put('/api/leads/10').send({ status: 'WON' });
    expect(bypassPut.status).toBe(400);

    const bypassPatch = await request(app).patch('/api/leads/10').send({ stage: 'SIGNED' });
    expect(bypassPatch.status).toBe(400);

    // Reassign via PATCH /:id calls atomic RPC and does NOT execute a second direct UPDATE for responsible_user_id
    mockRpc.mockResolvedValue({ data: { success: true, status: 'ASSIGNED', version: 2 }, error: null });
    const reassign = await request(app).patch('/api/leads/10').send({ responsible_user_id: 3, reassignment_reason: 'Передача' });
    expect(reassign.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('fn_assign_lead_atomic', expect.objectContaining({ p_target_user_id: 3 }));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('preserves distinct HTTP 409 error codes (IDEMPOTENCY_CONFLICT vs VERSION_CONFLICT) and avoids duplicate direct task trigger', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/leads', leadsRouter);

    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
      id: 10, full_name: 'Lead 10', responsible_user_id: 1, stage: 'NEW', status: 'NEW', version: 2
    });

    mockRpc.mockResolvedValueOnce({
      data: { success: false, status_code: 409, error_code: 'IDEMPOTENCY_CONFLICT', message: 'Другой смысл запроса' },
      error: null
    });
    const idemRes = await request(app).patch('/api/leads/10/status').send({ stage: 'IN_PROGRESS', version: 1, idempotency_key: 'k1' });
    expect(idemRes.status).toBe(409);
    expect(idemRes.body.code).toBe('IDEMPOTENCY_CONFLICT');

    mockRpc.mockResolvedValueOnce({
      data: { success: false, status_code: 409, error_code: 'VERSION_CONFLICT', message: 'Версия устарела' },
      error: null
    });
    const verRes = await request(app).patch('/api/leads/10/status').send({ stage: 'IN_PROGRESS', version: 1 });
    expect(verRes.status).toBe(409);
    expect(verRes.body.code).toBe('VERSION_CONFLICT');

    // Successful transition uses outbox only (no duplicate direct TasksService.onLeadStatusChanged call)
    mockRpc.mockResolvedValueOnce({
      data: { success: true, status: 'UPDATED', replayed: false, stage: 'IN_PROGRESS', version: 3 },
      error: null
    });
    const okRes = await request(app).patch('/api/leads/10/status').send({ stage: 'IN_PROGRESS', version: 2 });
    expect(okRes.status).toBe(200);
    expect(mockOnLeadStatusChanged).not.toHaveBeenCalled();
  });
});
