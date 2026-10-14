import { describe, expect, it, vi, beforeEach } from 'vitest';

const { from, getDB, getServiceDB } = vi.hoisted(() => ({
  from: vi.fn(), getDB: vi.fn(), getServiceDB: vi.fn()
}));
vi.mock('../../db/connection.js', () => ({ getDB, getServiceDB }));
import { Tour360Repository } from './tour360.repository.js';

describe('360 draft publication security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDB.mockReturnValue({ from });
  });

  it('blocks activation of unpublished draft before any update query', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: false } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single }) }) });
    await expect(Tour360Repository.updateTour(3, { is_active: true })).rejects.toThrow('Публикация черновика недоступна');
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('rejects new panorama registration for an already published tour', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: true } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single }) }) });
    await expect(Tour360Repository.createPanorama(3, { name: 'Гостиная', storage_path: 'projects/2/360/3/a.jpg' })).rejects.toThrow('Изменять опубликованный тур запрещено');
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('rejects foreign storage paths for a draft', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: false } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single }) }) });
    await expect(Tour360Repository.createPanorama(3, { name: 'Гостиная', storage_path: 'projects/99/360/3/a.jpg' })).rejects.toThrow('Путь панорамы не принадлежит');
    expect(from).toHaveBeenCalledTimes(1);
  });
});
