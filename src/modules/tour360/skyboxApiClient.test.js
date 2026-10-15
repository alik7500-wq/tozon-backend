import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkyboxApiClient } from './skyboxApiClient.js';

const fakeFetch = calls => async (url, options) => {
  calls.push({ url, options });
  return { ok: true, json: async () => url.endsWith('/skybox') ? { id: 123, status: 'pending' } : url.includes('/styles') ? { styles: [] } : { request: { id: 123, status: 'complete' } };
};

test('Skybox API client never calls provider during construction', () => {
  const calls = [];
  createSkyboxApiClient({ apiKey: 'test', fetchImpl: fakeFetch(calls) });
  assert.equal(calls.length, 0);
});

test('Skybox API client creates generation with authenticated JSON request', async () => {
  const calls = [];
  const client = createSkyboxApiClient({ apiKey: 'test', fetchImpl: fakeFetch(calls) });
  const result = await client.createGeneration({ styleId: 12, prompt: 'modern apartment' });
  assert.equal(result.id, 123);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-api-key'], 'test');
  assert.deepEqual(JSON.parse(calls[0].options.body), { skybox_style_id: 12, prompt: 'modern apartment' });
});

test('Skybox API client checks styles and generation status', async () => {
  const calls = [];
  const client = createSkyboxApiClient({ apiKey: 'test', fetchImpl: fakeFetch(calls) });
  await client.listStyles(4);
  const status = await client.getGeneration(123);
  assert.equal(status.status, 'complete');
  assert.match(calls[0].url, /model_version=4/);
  assert.match(calls[1].url, /\/imagine\/requests\/123$/);
});

test('Skybox API client rejects invalid jobs before any API calls', async () => {
  const calls = [];
  const client = createSkyboxApiClient({ apiKey: 'test', fetchImpl: fakeFetch(calls) });
  await assert.rejects(client.createGeneration({ styleId: 0, prompt: 'x' }), /style ID/);
  await assert.rejects(client.getGeneration(-1), /generation ID/);
  await assert.rejects(client.listStyles(7), /Skybox model/);
  assert.equal(calls.length, 0);
});
