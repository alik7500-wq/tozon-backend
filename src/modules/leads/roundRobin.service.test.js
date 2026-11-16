import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSalesManagers: vi.fn(),
  getDB: vi.fn(),
  isWithinWorkingHours: vi.fn()
}));

vi.mock('../sales-plans/salesPlans.repository.js', () => ({
  SalesPlansRepository: { getSalesManagers: mocks.getSalesManagers }
}));
vi.mock('./distributionSettings.service.js', () => ({
  DistributionSettingsService: { getSettings: mocks.getSettings }
}));
vi.mock('../../utils/businessTime.js', () => ({
  isWithinWorkingHours: mocks.isWithinWorkingHours
}));
vi.mock('../../db/connection.js', () => ({ getDB: mocks.getDB }));

import { RoundRobinService } from './roundRobin.service.js';

const settings = {
  enabled: true, algorithm: 'LEAST_LOADED', workingHoursOnly: true,
  maxOpenLeadsPerRep: 25, excludedUserIds: []
};
const reps = [
  { id: 3, name: 'Manager A', is_active: 1, is_sales_rep: true },
  { id: 11, name: 'Manager B', is_active: 1, is_sales_rep: true }
];

describe('lead distribution safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    RoundRobinService.resetInFlight();
    mocks.getSettings.mockResolvedValue(settings);
    mocks.getSalesManagers.mockResolvedValue(reps);
    mocks.isWithinWorkingHours.mockReturnValue(true);
    mocks.getDB.mockReturnValue({
      from: () => ({
        select: () => ({
          in: () => ({
            in: () => ({
              is: async () => ({ data: [], error: null })
            })
          })
        })
      })
    });
  });

  it('preserves explicit manager without querying workload', async () => {
    const result = await RoundRobinService.resolveAssignment(11);
    expect(result.responsible_user_id).toBe(11);
    expect(result.assignment_type).toBe('MANUAL');
    expect(mocks.getSalesManagers).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing manager', async () => {
    const result = await RoundRobinService.resolveAssignment(null, 3);
    expect(result.responsible_user_id).toBe(3);
    expect(result.assignment_type).toBe('EXISTING');
    expect(mocks.getSalesManagers).not.toHaveBeenCalled();
  });

  it('keeps leads in pool outside working hours', async () => {
    mocks.isWithinWorkingHours.mockReturnValue(false);
    const result = await RoundRobinService.resolveAssignment();
    expect(result.responsible_user_id).toBeNull();
    expect(result.assignment_type).toBe('POOL');
  });

  it('fails closed when workload query returns an error', async () => {
    mocks.getDB.mockReturnValue({
      from: () => ({
        select: () => ({
          in: () => ({
            in: () => ({
              is: async () => ({ data: null, error: { message: 'DB unavailable' } })
            })
          })
        })
      })
    });
    const result = await RoundRobinService.resolveAssignment();
    expect(result.responsible_user_id).toBeNull();
    expect(result.assignment_type).toBe('POOL');
  });

  it('respects capacity and exclusions', async () => {
    mocks.getSettings.mockResolvedValue({ ...settings, maxOpenLeadsPerRep: 1, excludedUserIds: [11] });
    mocks.getDB.mockReturnValue({
      from: () => ({
        select: () => ({
          in: () => ({
            in: () => ({
              is: async () => ({ data: [{ id: 9, responsible_user_id: 3 }], error: null })
            })
          })
        })
      })
    });
    const result = await RoundRobinService.resolveAssignment();
    expect(result.responsible_user_id).toBeNull();
  });

  it('releases the reserved slot after successful selection', async () => {
    const result = await RoundRobinService.resolveAssignment();
    expect([3, 11]).toContain(result.responsible_user_id);
    expect(RoundRobinService.getInFlightWorkload(result.responsible_user_id)).toBe(1);
    result.releaseSlot();
    expect(RoundRobinService.getInFlightWorkload(result.responsible_user_id)).toBe(0);
  });
});
