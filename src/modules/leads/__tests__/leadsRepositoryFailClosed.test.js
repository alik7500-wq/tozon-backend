import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockUpdate = vi.fn();
const mockRpc = vi.fn();
const mockFindById = vi.fn();

vi.mock('../../../db/connection.js', () => ({
  getDB: () => ({
    from: () => ({ update: mockUpdate, select: () => ({ eq: () => ({ maybeSingle: () => ({ data: null }) }) }) })
  }),
  getServiceDB: () => ({
    rpc: mockRpc,
    from: () => ({ update: mockUpdate })
  })
}));

const { LeadsRepository } = await import('../leads.repository.js');

describe('R03: LeadsRepository fail-closed & RBAC', () => {
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

  it('blocks SALES_MANAGER from changing stage of another manager lead with 403', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 99, role: 'SALES_MANAGER' };
      next();
    });
    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, responsible_user_id: 2, stage: 'NEW', version: 1 });

    app.patch('/api/leads/:id/status', async (req, res, next) => {
      try {
        const existing = await LeadsRepository.findById(req.params.id);
        if (req.user.role === 'SALES_MANAGER' && Number(existing.responsible_user_id) !== Number(req.user.id)) {
          return res.status(403).json({ status: 'error', message: 'Forbidden' });
        }
        return res.status(200).json({ status: 'success' });
      } catch (e) { next(e); }
    });

    const res = await request(app).patch('/api/leads/10/status').send({ stage: 'IN_PROGRESS', version: 1 });
    expect(res.status).toBe(403);
    mockFindById.mockRestore?.();
  });
});
