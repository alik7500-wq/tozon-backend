import { describe, expect, it } from 'vitest';
import { createTourSchema, uploadUrl360Schema } from './tour360.validator.js';

describe('360 private draft validation contract', () => {
  it('defaults newly created tours to inactive', () => {
    const parsed = createTourSchema.parse({ name: 'Пилот', tour_type: 'SHOWROOM' });
    expect(parsed.is_active).toBe(false);
  });
  it('rejects attempts to create an already published tour', () => {
    expect(() => createTourSchema.parse({ name: 'Пилот', tour_type: 'SHOWROOM', is_active: true })).toThrow();
  });
  it('accepts frontend signed upload payload for JPG draft', () => {
    expect(uploadUrl360Schema.parse({ projectId: 3, tourId: 7, filename: 'room.jpg', fileSizeBytes: 1024 }).tourId).toBe(7);
  });
});
