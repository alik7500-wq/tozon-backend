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
  it('does not require a database connection when scheduler is disabled', async () => {
    delete process.env.LEAD_QUEUE_SCHEDULER_ENABLED;
    await expect(processScheduledLeadQueue()).resolves.toMatchObject({ status: 'DISABLED' });
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
  it('assigns three new leads across two available managers without touching older records', async () => {
    const leads = [101, 102, 103].map(id => ({
      id, status: 'NEW', responsible_user_id: null
    }));
    const { db, query } = mockDb(leads);
    mocks.findById.mockImplementation(async id => ({
      id, status: 'NEW', responsible_user_id: null
    }));
    mocks.resolve
      .mockResolvedValueOnce({ responsible_user_id: 3, releaseSlot: vi.fn() })
      .mockResolvedValueOnce({ responsible_user_id: 11, releaseSlot: vi.fn() })
      .mockResolvedValueOnce({ responsible_user_id: 3, releaseSlot: vi.fn() });
    mocks.assignManager.mockImplementation(async (_id, userId) => ({
      responsible_user_id: userId
    }));
    const result = await processScheduledLeadQueue({ db });
    expect(result).toMatchObject({ status: 'COMPLETED', processed: 3, assigned: 3 });
    expect(mocks.assignManager.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [101, 3], [102, 11], [103, 3]
    ]);
    expect(query.gte).toHaveBeenCalledWith('created_at', new Date(cutoff).toISOString());
    expect(query.limit).toHaveBeenCalledWith(10);
  });
  it('stops immediately when distribution is disabled during a batch', async () => {
    const { db } = mockDb([
      { id: 101, status: 'NEW', responsible_user_id: null },
      { id: 102, status: 'NEW', responsible_user_id: null }
    ]);
    mocks.settings
      .mockResolvedValueOnce({ state: 'SUCCESS', enabled: true })
      .mockResolvedValueOnce({ state: 'SUCCESS', enabled: true })
      .mockResolvedValueOnce({ state: 'SUCCESS', enabled: false });
    const result = await processScheduledLeadQueue({ db });
    expect(result).toMatchObject({ status: 'STOPPED', assigned: 1 });
    expect(mocks.assignManager).toHaveBeenCalledTimes(1);
  });
  it('does not assign anything when the distribution setting is disabled', async () => {
    const { db } = mockDb();
    mocks.settings.mockResolvedValue({ state: 'SUCCESS', enabled: false });
    expect((await processScheduledLeadQueue({ db })).status).toBe('DISTRIBUTION_DISABLED');
    expect(db.rpc).not.toHaveBeenCalled();
  });

});
