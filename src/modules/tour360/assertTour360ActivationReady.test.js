import { describe, expect, it } from 'vitest';
import { assertTour360ActivationReady } from './assertTour360ActivationReady.js';
const job = { id: 'job-1', state: 'VERIFYING', tour_id: 8, project_id: 3 };
const tour = { id: 8, project_id: 3, is_active: false };
const gate = { job_id: 'job-1', ready: true, activated: false, checksums: { files: [{ path: 'a', matches: true }] }, existence: { files: [{ path: 'a', exists: true, size: 1024 }] } };

describe('360 tour activation preconditions', () => {
  it('accepts a fully verified inactive tour', () => {
    expect(assertTour360ActivationReady({ job, gate, tour }).can_prepare_activation).toBe(true);
  });
  it('rejects an unverified checksum', () => {
    expect(() => assertTour360ActivationReady({ job, gate: { ...gate, checksums: { files: [{ matches: false }] } }, tour })).toThrow('ACTIVATION_CHECKSUMS_UNVERIFIED');
  });
  it('rejects a tour from another project', () => {
    expect(() => assertTour360ActivationReady({ job, gate, tour: { ...tour, project_id: 4 } })).toThrow('ACTIVATION_TOUR_MISMATCH');
  });
  it('rejects an already active tour', () => {
    expect(() => assertTour360ActivationReady({ job, gate, tour: { ...tour, is_active: true } })).toThrow('ACTIVATION_TOUR_MISMATCH');
  });
});
