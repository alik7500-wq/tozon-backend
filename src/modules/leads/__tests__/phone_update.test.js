import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getDB: vi.fn(), getServiceDB: vi.fn() }));
vi.mock('../../../db/connection.js', () => mocks);
import { LeadsRepository } from '../leads.repository.js';
afterEach(() => vi.restoreAllMocks());
describe('Authorized client phone update', () => {
  it('writes with the server role so private portal revocation can run', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn(() => ({ eq }));
    mocks.getServiceDB.mockReturnValue({ from: vi.fn(() => ({ update })) });
    mocks.getDB.mockImplementation(() => { throw new Error('Anonymous write forbidden'); });
    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 12, phone: '+992900000001' });
    await expect(LeadsRepository.update(12, { phone: '+992900000001' })).resolves.toMatchObject({ id: 12 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ phone: '+992900000001' }));
    expect(eq).toHaveBeenCalledWith('id', 12);
    expect(mocks.getDB).not.toHaveBeenCalled();
  });
  it('fails closed when the server role is unavailable', async () => {
    mocks.getServiceDB.mockImplementation(() => { throw new Error('Service role required'); });
    await expect(LeadsRepository.update(12, { phone: '+992900000001' })).rejects.toThrow('Service role required');
  });
});
