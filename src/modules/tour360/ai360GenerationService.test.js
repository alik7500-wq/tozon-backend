import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAi360Image, generateAi360PilotDraft } from './ai360GenerationService.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const tour = { id: 77, project_id: 3, is_active: false };

test('rejects empty and forged image responses', () => {
  assert.throws(() => validateAi360Image({ mimeType: 'image/jpeg', bytes: Buffer.alloc(0) }), /size/);
  assert.throws(() => validateAi360Image({ mimeType: 'image/jpeg', bytes: Buffer.from('not a jpeg') }), /signature/);
  assert.throws(() => validateAi360Image({ mimeType: 'image/png', bytes: jpeg }), /signature/);
});

test('does not call provider or storage for published tours or mismatched projects', async () => {
  let calls = 0;
  const provider = { generate: async () => { calls++; return { bytes: jpeg, mimeType: 'image/jpeg' }; } };
  const draftStorage = { upload: async () => { calls++; return { ok: true }; } };
  await assert.rejects(generateAi360PilotDraft({ provider, draftStorage, tour: { ...tour, is_active: true }, projectId: 3, room: 'Гостиная' }), /inactive/);
  await assert.rejects(generateAi360PilotDraft({ provider, draftStorage, tour, projectId: 4, room: 'Гостиная' }), /mismatch/);
  assert.equal(calls, 0);
});

test('uploads generated image only to draft adapter with scoped path', async () => {
  let uploaded;
  const provider = { generate: async ({ projection, width, height, references }) => {
    assert.equal(projection, 'equirectangular');
    assert.equal(width, 4096);
    assert.equal(height, 2048);
    assert.equal(references.length, 2);
    return { bytes: jpeg, mimeType: 'image/jpeg' };
  } };
  const draftStorage = { upload: async (data) => { uploaded = data; return { ok: true }; } };
  const result = await generateAi360PilotDraft({ provider, draftStorage, tour, projectId: 3, room: 'Гостиная' });
  assert.match(uploaded.path, /^projects\/3\/360\/77\/ai_1_[\w-]+\.jpg$/);
  assert.equal(uploaded.upsert, false);
  assert.equal(result.status, 'DRAFT_UPLOADED_NOT_PUBLISHED');
  assert.equal(result.requiresProjectionValidation, true);
});

test('fails closed if private upload fails', async () => {
  await assert.rejects(generateAi360PilotDraft({
    provider: { generate: async () => ({ bytes: jpeg, mimeType: 'image/jpeg' }) },
    draftStorage: { upload: async () => ({ ok: false }) },
    tour, projectId: 3, room: 'Кухня'
  }), /upload failed/);
});
