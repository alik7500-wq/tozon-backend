import { beforeEach, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const mocks = vi.hoisted(() => ({ role: 'ADMIN', update: vi.fn() }));
vi.mock('../../middleware/auth.middleware.js', () => ({
  protect: (req, res, next) => { req.user = { role: mocks.role }; req.sectionAccessGranted = true; next(); },
  restrictTo: () => (req, res, next) => next()
}));
vi.mock('./inventory.repository.js', () => ({ InventoryRepository: { updateBuildingAreas: mocks.update } }));
vi.mock('./alternativeUnits.service.js', () => ({ AlternativeUnitsService: {} }));
import router from './inventory.router.js';
const app = express(); app.use(express.json()); app.use('/api/inventory', router);
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
const url = '/api/inventory/projects/3/buildings/4/areas';
beforeEach(() => { vi.clearAllMocks(); mocks.role = 'ADMIN'; mocks.update.mockResolvedValue({ id: 4, project_id: 3, footprint_area_m2_x100: 59500 }); });
it.each(['ADMIN', 'DIRECTOR'])('allows %s to update the selected project and building', async role => {
  mocks.role = role;
  expect((await request(app).patch(url).send({ footprint_area_m2_x100: 59500 })).status).toBe(200);
  expect(mocks.update).toHaveBeenCalledWith(3, 4, { footprint_area_m2_x100: 59500 });
});
it('denies non-management users even with general matrix access', async () => {
  mocks.role = 'SALES_MANAGER';
  expect((await request(app).patch(url).send({ footprint_area_m2_x100: 59500 })).status).toBe(403);
  expect(mocks.update).not.toHaveBeenCalled();
});
it('rejects invalid payloads before writing', async () => {
  expect((await request(app).patch(url).send({ project_id: 9, footprint_area_m2_x100: -1 })).status).toBe(400);
  expect(mocks.update).not.toHaveBeenCalled();
});
