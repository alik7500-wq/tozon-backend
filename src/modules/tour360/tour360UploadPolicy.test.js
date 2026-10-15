import { describe, expect, it } from 'vitest';
import { uploadUrl360Schema } from './tour360.validator.js';

const valid = { projectId: 3, tourId: 7, filename: 'room.webp', fileSizeBytes: 26214400 };
describe('private 360 draft upload validation', () => {
  it('accepts JPEG/WEBP at the 25MB limit', () => {
    expect(uploadUrl360Schema.parse(valid).filename).toBe('room.webp');
    expect(uploadUrl360Schema.parse({ ...valid, filename: 'room.jpeg' }).filename).toBe('room.jpeg');
  });
  it('rejects PNG and larger-than-25MB files', () => {
    expect(uploadUrl360Schema.safeParse({ ...valid, filename: 'room.png' }).success).toBe(false);
    expect(uploadUrl360Schema.safeParse({ ...valid, fileSizeBytes: 26214401 }).success).toBe(false);
  });
});
