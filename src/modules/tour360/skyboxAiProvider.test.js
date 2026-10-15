import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkyboxAiProvider } from './skyboxAiProvider.js';

const settings = { apiKey: 'test-only-key', apiBaseUrl: 'https://example.invalid', transport: async () => ({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg', projectionVerified: true }) };
const request = { prompt: 'Living room', width: 4096, height: 2048, projection: 'equirectangular', references: ['https://example.com/furnished.png', 'https://example.com/plan.png'] };

test('Skybox provider requires explicit credentials and a verified transport', () => {
  assert.throws(() => createSkyboxAiProvider({ apiKey: '', apiBaseUrl: settings.apiBaseUrl, transport: settings.transport }), /SKYBOX_API_KEY/);
  assert.throws(() => createSkyboxAiProvider({ apiKey: settings.apiKey, apiBaseUrl: 'http://example.com', transport: settings.transport }), /HTTPS/);
  assert.throws(() => createSkyboxAiProvider({ apiKey: settings.apiKey, apiBaseUrl: settings.apiBaseUrl }), /transport/);
});

test('Skybox provider rejects non-spherical output and unsupported MIME', async () => {
  const badProjection = createSkyboxAiProvider({ ...settings, transport: async () => ({ mimeType: 'image/jpeg', projectionVerified: false }) });
  await assert.rejects(badProjection.generate(request), /not verified/);
  const badMime = createSkyboxAiProvider({ ...settings, transport: async () => ({ mimeType: 'image/png', projectionVerified: true }) });
  await assert.rejects(badMime.generate(request), /Unsupported panorama/);
});

test('Skybox provider rejects incorrect targets without spending credits', async () => {
  let calls = 0;
  const provider = createSkyboxAiProvider({ ...settings, transport: async () => { calls++; return settings.transport(); } });
  await assert.rejects(provider.generate({ ...request, width: 1024 }), /Invalid panorama/);
  await assert.rejects(provider.generate({ ...request, references: [] }), /references/);
  assert.equal(calls, 0);
});

test('Skybox provider accepts verified spherical JPEG through injected transport', async () => {
  const result = await createSkyboxAiProvider(settings).generate(request);
  assert.equal(result.projectionVerified, true);
  assert.equal(result.mimeType, 'image/jpeg');
});
