import { describe, expect, it, vi } from 'vitest';
import { Tour360PublishJournal } from './tour360PublishJournal.js';

describe('publication journal state machine', () => {
  it('rejects activation without verification', async () => {
    const from = vi.fn();
    const journal = new Tour360PublishJournal({ from });
    await expect(journal.transition('job', 'COPYING', 'ACTIVATING')).rejects.toThrow('INVALID_PUBLISH_TRANSITION');
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects invalid copied file records', async () => {
    const from = vi.fn();
    const journal = new Tour360PublishJournal({ from });
    await expect(journal.transition('job', 'COPYING', 'VERIFYING', { copied_paths: [123] })).rejects.toThrow('INVALID_COPIED_PATHS');
    expect(from).not.toHaveBeenCalled();
  });

  it('detects concurrent state change', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const chain = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), maybeSingle };
    chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain);
    const journal = new Tour360PublishJournal({ from: () => chain });
    await expect(journal.transition('job', 'PREPARING', 'COPYING')).rejects.toThrow('PUBLISH_JOB_CONCURRENT_CHANGE');
  });
});
