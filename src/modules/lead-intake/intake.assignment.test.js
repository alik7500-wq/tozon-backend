import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAssignment: vi.fn(),
  assignManager: vi.fn()
}));
vi.mock('../leads/roundRobin.service.js', () => ({
  RoundRobinService: { resolveAssignment: mocks.resolveAssignment }
}));
vi.mock('../leads/leads.repository.js', () => ({
  LeadsRepository: { assignManager: mocks.assignManager }
}));

import { assignNewIntakeLead } from './intake.assignment.js';

describe('new intake lead assignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAssignment.mockResolvedValue({
      responsible_user_id: 3,
      reason: 'Auto',
      releaseSlot: vi.fn()
    });
    mocks.assignManager.mockResolvedValue({ responsible_user_id: 3 });
  });

  it.each(['DUPLICATE', 'REPEAT', 'ARCHIVED', 'AMBIGUOUS'])(
    'never reassigns an inquiry with outcome %s', async outcome => {
      expect(await assignNewIntakeLead({ outcome, lead_id: 9 })).toBe(false);
      expect(mocks.resolveAssignment).not.toHaveBeenCalled();
    }
  );

  it('preserves explicitly configured manager', async () => {
    expect(await assignNewIntakeLead({ outcome: 'CREATED', lead_id: 9 }, { hasExplicitManager: true })).toBe(false);
    expect(mocks.assignManager).not.toHaveBeenCalled();
  });

  it('assigns only new leads through atomic RPC and releases slot', async () => {
    expect(await assignNewIntakeLead({ outcome: 'CREATED', lead_id: 9 })).toBe(true);
    expect(mocks.assignManager).toHaveBeenCalledWith(9, 3, 'Auto', null, false, true);
    expect(mocks.resolveAssignment.mock.results[0].value).toBeDefined();
  });

  it('keeps saved intake successful if assignment fails', async () => {
    mocks.assignManager.mockRejectedValue(new Error('Database unavailable'));
    expect(await assignNewIntakeLead({ outcome: 'CREATED', lead_id: 9 })).toBe(false);
  });

  it('leaves lead unassigned when no rep is available', async () => {
    mocks.resolveAssignment.mockResolvedValue({ responsible_user_id: null });
    expect(await assignNewIntakeLead({ outcome: 'CREATED', lead_id: 9 })).toBe(false);
    expect(mocks.assignManager).not.toHaveBeenCalled();
  });
});
