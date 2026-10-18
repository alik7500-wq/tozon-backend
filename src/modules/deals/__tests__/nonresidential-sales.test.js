import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DealsRepository } from '../deals.repository.js';
const mock = vi.hoisted(() => ({ from: vi.fn(), notify: vi.fn() }));
vi.mock('../../../db/connection.js', () => ({ getDB: () => ({ from: mock.from }), getServiceDB: () => ({ from: mock.from }) }));
vi.mock('../../document-settings/configuration.js', () => ({ getDealRules: async () => ({ max_discount_percent: 100, reservation_days: 3 }) }));
vi.mock('../../notifications/notifications.service.js', () => ({ NotificationsService: { notifyReservationCreated: mock.notify } }));
const unit = { id: 300, unit_kind: 'PARKING', unit_number: 'П-01', rooms: 0, status: 'AVAILABLE', area_m2_x100: 2552, price_per_m2_minor: 20000, floors: { floor_number: -1, sections: { buildings: { name: 'Блок Б', projects: { id: 3, code: 'TEST', currency: 'USD' } } } } };
const deal = { id: 55, unit_id: 300, contract_number: '0055', status: 'SIGNED', final_price_minor: 510400, deal_price_per_m2_minor: 20000, down_payment_minor: 0, units: unit, leads: {}, payments: [], deal_payment_schedules: [] };
let writes;
function database(readUnit = unit, readDeal = deal) {
  mock.from.mockImplementation(table => {
    let operation = 'read';
    const response = () => ({ data: table === 'units' ? readUnit : readDeal, count: 0, error: null });
    const chain = {
      select: vi.fn(() => chain), eq: vi.fn(() => chain), is: vi.fn(() => chain), order: vi.fn(() => chain),
      single: vi.fn(async () => response()),
      insert: vi.fn(data => { operation = 'write'; writes.push({ table, data }); return chain; }),
      update: vi.fn(data => { operation = 'write'; writes.push({ table, data }); return chain; }),
      then: (resolve, reject) => Promise.resolve({ ...response(), data: operation === 'write' ? response().data : [response().data] }).then(resolve, reject),
    };
    return chain;
  });
}
beforeEach(() => { vi.restoreAllMocks(); mock.from.mockReset(); mock.notify.mockReset(); mock.notify.mockResolvedValue(); writes = []; database(); });
describe('nonresidential deals use the existing accounting flow', () => {
  it.each(['PARKING', 'COMMERCIAL'])('returns %s in available units, deal list and full deal', async kind => {
    const typedUnit = { ...unit, unit_kind: kind };
    database(typedUnit, { ...deal, units: typedUnit });
    expect((await DealsRepository.getAvailableUnits(3))[0].unit_kind).toBe(kind);
    expect((await DealsRepository.findAll())[0].unit_kind).toBe(kind);
    const full = await DealsRepository.getDealById(55);
    expect(full.unit_kind).toBe(kind);
    expect(full.deal_price_per_m2_minor).toBe(20000);
    expect(full.remaining_debt_minor).toBe(510400);
    expect(full.floor_number).toBe(-1);
  });
  it.each(['SIGNED', 'RESERVED'])('creates %s and changes the parking status through the shared flow', async status => {
    vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ ...deal, status, unit_kind: 'PARKING' });
    await DealsRepository.createDeal({ lead_id: 1, unit_id: 300, status, payment_type: 'FULL', base_price_minor: 510400, final_price_minor: 510400 }, 1);
    expect(writes.find(w => w.table === 'units').data.status).toBe(status === 'SIGNED' ? 'SOLD' : 'RESERVED');
    expect(writes.find(w => w.table === 'deals').data[0].unit_id).toBe(300);
    expect(writes.some(w => w.table === 'payments')).toBe(false);
    if (status === 'RESERVED') expect(mock.notify).toHaveBeenCalledWith(expect.objectContaining({ unit_kind: 'PARKING' }));
  });
  it('rejects a sale without a positive price before any write', async () => {
    await expect(DealsRepository.createDeal({ unit_id: 300, final_price_minor: 0 }, 1)).rejects.toThrow('положительную стоимость');
    expect(writes).toHaveLength(0);
  });
  it('does not sell an already sold parking space', async () => {
    database({ ...unit, status: 'SOLD' });
    await expect(DealsRepository.createDeal({ unit_id: 300, final_price_minor: 100 }, 1)).rejects.toThrow('недоступен');
    expect(writes).toHaveLength(0);
  });
});
