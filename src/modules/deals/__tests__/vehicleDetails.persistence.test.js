import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
vi.mock('../../../db/connection.js', () => ({ getDB: vi.fn(), getServiceDB: vi.fn() }));
vi.mock('../../document-settings/configuration.js', () => ({ getDealRules: vi.fn(async () => ({ max_discount_percent: 100, reservation_days: 3 })) }));
vi.mock('../../notifications/notifications.service.js', () => ({ NotificationsService: {} }));
import { getDB } from '../../../db/connection.js';
import { DealsRepository } from '../deals.repository.js';
const car = { brand_model: 'Test Model', production_year: '2021', mileage_km: '0', handover_date: '2026-10-22', vin: 'TESTVIN' };
const sale = { lead_id: 1, unit_id: 2, status: 'SIGNED', payment_type: 'PARTIAL_BARTER', base_price_minor: 5000000, final_price_minor: 5000000, down_payment_minor: 1500000, barter_amount_minor: 1400000, deal_date: '2026-10-22', first_payment_date: '2026-11-22', vehicle_details: car };
let saved;
beforeEach(() => {
 vi.restoreAllMocks(); vi.clearAllMocks(); saved = null;
 getDB.mockReturnValue({ from(table) {
  let operation = 'select';
  const result = () => ({ data: operation === 'insert' ? saved : table === 'units' ? { id: 2, status: 'AVAILABLE', area_m2_x100: 5000, floors: { sections: { buildings: { projects: { currency: 'USD' } } } } } : null, count: 0, error: null });
  const q = { select: () => q, eq: () => q, update: () => q, insert: rows => { operation = 'insert'; saved = { id: 10, ...rows[0] }; return q; }, single: async () => result(), then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject) };
  return q;
 } });
 vi.spyOn(DealsRepository, 'getDealById').mockImplementation(async id => ({ ...saved, id }));
});
describe('vehicle persistence with the sale', () => {
 it('stores the normalized vehicle on the contract row and returns it to the client', async () => {
  const result = await DealsRepository.createDeal(sale, 1);
  expect(saved.vehicle_details).toEqual(car); expect(result.vehicle_details).toEqual(car);
  expect(saved.barter_amount_minor).toBe(1400000); expect(saved.down_payment_minor).toBe(1500000);
 });
 it('does not attach stale car data to a cash-only contract', async () => {
  await expect(DealsRepository.createDeal({ ...sale, payment_type: 'FULL' }, 1)).rejects.toThrow();
  expect(getDB).not.toHaveBeenCalled();
 });
 it('rejects malformed data before any database work', async () => {
  await expect(DealsRepository.createDeal({ ...sale, vehicle_details: { mileage_km: '-10' } }, 1)).rejects.toThrow();
  expect(getDB).not.toHaveBeenCalled();
 });
 it('adds storage without rewriting older rows; JSON survives a PostgreSQL round trip', async () => {
  const db = new PGlite();
  try {
   await db.exec('create table public.deals(id int primary key,final_price_minor int); insert into public.deals values(1,5000000);');
   const sql = readFileSync(new URL('../../../db/migrations/20261022125226_deal_vehicle_details.sql',import.meta.url),'utf8');
   await db.exec(sql);
   expect((await db.query('select * from deals where id=1')).rows).toEqual([{ id: 1, final_price_minor: 5000000, vehicle_details: null }]);
   await db.query('insert into deals(id,final_price_minor,vehicle_details) values(2,5000000,$1::jsonb)', [JSON.stringify(car)]);
   expect((await db.query('select vehicle_details from deals where id=2')).rows[0].vehicle_details).toEqual(car);
   await expect(db.query("insert into deals(id,vehicle_details) values(3,'[]')")).rejects.toThrow();
  } finally { await db.close(); }
 }, 20000);
});
