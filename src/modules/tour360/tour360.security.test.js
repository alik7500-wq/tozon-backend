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
    getServiceDB.mockReturnValue({ from });
  });

  it('blocks activation of unpublished draft before any update query', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: false } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single, maybeSingle: vi.fn().mockResolvedValue({ data: { is_active: false }, error: null }) }) }) });
    await expect(Tour360Repository.updateTour(3, { is_active: true })).rejects.toThrow('Публикация черновика недоступна');
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('rejects new panorama registration for an already published tour', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: true } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single, maybeSingle: vi.fn().mockResolvedValue({ data: { is_active: false }, error: null }) }) }) });
    await expect(Tour360Repository.createPanorama(3, { name: 'Гостиная', storage_path: 'projects/2/360/3/a.jpg' })).rejects.toThrow('Изменять опубликованный тур запрещено');
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('rejects foreign storage paths for a draft', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: false } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single, maybeSingle: vi.fn().mockResolvedValue({ data: { is_active: false }, error: null }) }) }) });
    await expect(Tour360Repository.createPanorama(3, { name: 'Гостиная', storage_path: 'projects/99/360/3/a.jpg' })).rejects.toThrow('Путь панорамы не принадлежит');
    expect(from).toHaveBeenCalledTimes(1);
  });
  it('blocks activation even if an existing tour is active via generic PATCH', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: true } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single, maybeSingle: vi.fn().mockResolvedValue({ data: { is_active: true }, error: null }) }) }) });
    await expect(Tour360Repository.updateTour(3, { is_active: true })).rejects.toThrow('Изменять опубликованный тур запрещено');
  });

  it('blocks deactivation of an existing published tour', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: true } });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { is_active: true }, error: null });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single, maybeSingle }) }) });
    await expect(Tour360Repository.updateTour(3, { is_active: false })).rejects.toThrow('Изменять опубликованный тур запрещено');
  });

  it('rejects path traversal within an otherwise valid draft prefix', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: false } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single, maybeSingle: vi.fn().mockResolvedValue({ data: { is_active: false }, error: null }) }) }) });
    await expect(Tour360Repository.createPanorama(3, { name: 'Тест', storage_path: 'projects/2/360/3/../other.jpg' })).rejects.toThrow('Путь панорамы не принадлежит');
  });

  it('looks up owning tour visibility without returning private URLs', async () => {
    const panoramaSingle = vi.fn().mockResolvedValue({ data: { tour_id: 8 }, error: null });
    const tourSingle = vi.fn().mockResolvedValue({ data: { is_active: false }, error: null });
    const serviceFrom = vi.fn()
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ maybeSingle: panoramaSingle }) }) })
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ maybeSingle: tourSingle }) }) });
    getServiceDB.mockReturnValue({ from: serviceFrom });
    expect(await Tour360Repository.getPanoramaTourVisibility(17)).toEqual({ is_active: false });
    expect(serviceFrom).toHaveBeenCalledTimes(2);
  });

  it('limits private draft signed read URLs to five minutes while retaining published URL expiry', async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.test/signed' }, error: null });
    getServiceDB.mockReturnValue({ from, storage: { from: vi.fn().mockReturnValue({ createSignedUrl }) } });
    await Tour360Repository.getSignedReadUrl('panoramas-360-drafts', 'projects/3/360/1/test.jpg', 86400);
    expect(createSignedUrl).toHaveBeenLastCalledWith('projects/3/360/1/test.jpg', 300);
    await Tour360Repository.getSignedReadUrl('panoramas-360', 'projects/3/360/1/test.jpg', 86400);
    expect(createSignedUrl).toHaveBeenLastCalledWith('projects/3/360/1/test.jpg', 86400);
  });

  it('rejects unverified thumbnail paths before querying storage', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: false } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single }) }) });
    await expect(Tour360Repository.createPanorama(3, {
      name: 'Гостиная',
      storage_path: 'projects/2/360/3/1720000000000_room.jpg',
      thumbnail_path: 'projects/999/360/3/foreign.jpg'
    })).rejects.toThrow('Отдельная миниатюра пока не поддерживается');
  });

  it('rejects arbitrary filenames that were not issued by signed upload endpoint', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 3, project_id: 2, is_active: false } });
    from.mockReturnValue({ select: () => ({ eq: () => ({ single }) }) });
    await expect(Tour360Repository.createPanorama(3, {
      name: 'Гостиная', storage_path: 'projects/2/360/3/arbitrary.jpg'
    })).rejects.toThrow('требуется файл из подписанной загрузки');
  });

  it('uses an unpredictable UUID upload path and only the private draft bucket', async () => {
    const createSignedUploadUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: 'https://storage.example.test/signed-upload', token: 'mock-token' }, error: null
    });
    const storageFrom = vi.fn().mockReturnValue({ createSignedUploadUrl });
    const projectSingle = vi.fn().mockResolvedValue({ data: { id: 3 } });
    const tourSingle = vi.fn().mockResolvedValue({ data: { id: 7, project_id: 3, is_active: false }, error: null });
    const serviceFrom = vi.fn()
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ single: projectSingle }) }) })
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ maybeSingle: tourSingle }) }) });
    getServiceDB.mockReturnValue({ from: serviceFrom, storage: { from: storageFrom } });
    const result = await Tour360Repository.generateUploadUrl(3, { tourId: 7, filename: 'room.jpg', fileSizeBytes: 1024 });
    expect(result.storagePath).toMatch(/^projects\/3\/360\/7\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_room\.jpg$/i);
    expect(storageFrom).toHaveBeenCalledWith('panoramas-360-drafts');
    expect(createSignedUploadUrl).toHaveBeenCalledWith(result.storagePath);
  });

});
