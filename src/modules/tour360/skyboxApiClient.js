/** Verified against Blockade Labs public API docs (October 2026).
 * Pure API client: no calls occur until an explicit method invocation.
 * Creating a generation consumes credits; do not call automatically.
 */
const API = 'https://backend.blockadelabs.com/api/v1';
export function createSkyboxApiClient({ apiKey, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('Skybox API key required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation required');
  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(API + path, {
      method,
      headers: { 'x-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error('Skybox API HTTP ' + response.status);
    return response.json();
  }
  return {
    async listStyles(modelVersion = 3) {
      if (![3, 4].includes(modelVersion)) throw new Error('Unsupported Skybox model');
      return request('/skybox/styles?model_version=' + modelVersion);
    },
    async createGeneration({ styleId, prompt, negativeText, variantId }) {
      if (!Number.isSafeInteger(styleId) || styleId < 1) throw new Error('Valid style ID required');
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) throw new Error('Invalid prompt');
      const body = { skybox_style_id: styleId, prompt };
      if (negativeText) body.negative_text = negativeText;
      if (variantId !== undefined) {
        if (!Number.isSafeInteger(variantId) || variantId < 1) throw new Error('Invalid variant ID');
        body.variant_id = variantId;
      }
      const result = await request('/skybox', { method: 'POST', body });
      if (!Number.isSafeInteger(result?.id) || result.id < 1) throw new Error('Skybox returned invalid generation ID');
      return { id: result.id, status: result.status };
    },
    async getGeneration(id) {
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid generation ID');
      const result = await request('/imagine/requests/' + id);
      return result?.request ?? result;
    }
  };
}
