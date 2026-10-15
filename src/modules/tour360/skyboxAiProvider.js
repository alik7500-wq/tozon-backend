/**
 * Blockade Labs Skybox AI adapter for the TOZON 360 pilot.
 * Network requests are opt-in: this module does not call the provider on import.
 * The API base, version and request/response schema MUST be verified against
 * the account's current Blockade Labs API documentation before production use.
 * No secrets are embedded in source control.
 */
export function createSkyboxAiProvider({ apiKey = process.env.SKYBOX_API_KEY, transport, apiBaseUrl = process.env.SKYBOX_API_BASE_URL } = {}) {
  if (!apiKey) throw new Error('SKYBOX_API_KEY is not configured');
  if (!apiBaseUrl || !/^https:\/\//.test(apiBaseUrl)) throw new Error('A verified HTTPS SKYBOX_API_BASE_URL is required');
  if (typeof transport !== 'function') throw new Error('Verified Skybox transport adapter is required');
  return {
    async generate({ prompt, width, height, projection, references }) {
      if (projection !== 'equirectangular' || width !== 4096 || height !== 2048) throw new Error('Invalid panorama target');
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Missing room prompt');
      if (!Array.isArray(references) || references.length !== 2) throw new Error('Two floor plan references required');
      // Explicitly defer endpoint, model, job polling and credit use to the verified adapter.
      // Prevents fabricated API calls, accidental charges and unsafe URL downloads.
      const result = await transport({ apiKey, apiBaseUrl, prompt, width, height, projection, references });
      if (!result || result.projectionVerified !== true) throw new Error('Skybox output is not verified as spherical panorama');
      if (!['image/jpeg', 'image/webp'].includes(result.mimeType)) throw new Error('Unsupported panorama output format');
      return result;
    }
  };
}
