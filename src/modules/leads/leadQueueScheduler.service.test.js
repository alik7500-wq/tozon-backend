import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  settings: vi.fn(), findById: vi.fn(), assignManager: vi.fn(), resolve: vi.fn()
}));
vi.mock('./distributionSettings.service.js', () => ({
  DistributionSettingsService: { getSettings: mocks.settings }
}));
vi.mock('./leads.repository.js', () => ({
  LeadsRepository: { findById: mocks.findById, assignManager: mocks.assignManager }
}));
vi.mock('./roundRobin.service.js', () => ({
  RoundRobinService: { resolveAssignment: mocks.resolve }
}));
import { processScheduledLeadQueue } from './leadQueueScheduler.service.js';

const cutoff = '2026-11-17T00:00:00+00:00';
function mockDb(leads = [{ id: 101, status: 'NEW', responsible_user_id: null }]) {
  const release = vi.fn().mockResolvedValue({ data: true, error: null });
  const claim = vi.fn().mockResolvedValue({ data: cutoff, error: null });
  const query = {
    select: vi.fn(), is: vi.fn(), in: vi.fn(), gte: vi.fn(),
    order: vi.fn(), limit: vi.fn().mockResolvedValue({ data: leads, error: null })
  };
  for (const key of ['select', 'is', 'in', 'gte', 'order']) query[key].mockReturnValue(query);
  const db = { rpc: vi.fn((name, args) =>
    name === 'claim_lead_queue_scheduler' ? claim(args) : release(args)
  ), from: vi.fn(() => query) };
  return { db, query, claim, release };
}

describe('scheduled lead queue safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LEAD_QUEUE_SCHEDULER_ENABLED = 'true';
    mocks.settings.mockResolvedValue({ state: 'SUCCESS', enabled: true });
    mocks.findById.mockResolvedValue({ id: 101, status: 'NEW', responsible_user_id: null });
    mocks.resolve.mockResolvedValue({ responsible_user_id: 3, releaseSlot: vi.fn() });
    mocks.assignManager.mockResolvedValue({ responsible_user_id: 3 });
  });
  it('requires explicit environment opt-in', async () => {
    delete process.env.LEAD_QUEUE_SCHEDULER_ENABLED;
    const { db } = mockDb();
    expect((await processScheduledLeadQueue({ db })).status).toBe('DISABLED');
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('does not query leads when database lease is unavailable', async () => {
    const { db } = mockDb();
    db.rpc.mockResolvedValue({ data: null, error: null });
    expect((await processScheduledLeadQueue({ db })).status).toBe('NOT_ENABLED_OR_BUSY');
    expect(db.from).not.toHaveBeenCalled();
  });
  it('limits query to cutoff and releases lease after assignment', async () => {
    const { db, query, release } = mockDb();
    const result = await processScheduledLeadQueue({ db });
    expect(result.assigned).toBe(1);
    expect(query.gte).toHaveBeenCalledWith('created_at', new Date(cutoff).toISOString());
    expect(mocks.assignManager).toHaveBeenCalledWith(101, 3, 'Планировщик новых заявок', null, false, true);
    expect(release).toHaveBeenCalledOnce();
  });
  it('never overwrites lead already claimed by a manager', async () => {
    const { db } = mockDb();
    mocks.findById.mockResolvedValue({ id: 101, status: 'NEW', responsible_user_id: 11 });
    expect((await processScheduledLeadQueue({ db })).assigned).toBe(0);
    expect(mocks.assignManager).not.toHaveBeenCalled();
  });
  it('releases lease even if database query fails', async () => {
    const { db, query, release } = mockDb();
    query.limit.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    await expect(processScheduledLeadQueue({ db })).rejects.toEqual({ message: 'unavailable' });
    expect(release).toHaveBeenCalledOnce();
  });
});
