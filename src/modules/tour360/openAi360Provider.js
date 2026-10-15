import OpenAI from 'openai';

/**
 * Optional image-generation adapter. An ordinary image model does not guarantee
 * equirectangular projection or architectural fidelity: generated results MUST
 * remain drafts pending a visual 360° projection and floor-plan review.
 * No provider calls occur when the module is imported.
 */
export function createOpenAi360Provider({ apiKey = process.env.OPENAI_API_KEY, model = process.env.TOUR360_IMAGE_MODEL || 'gpt-image-1.5', client } = {}) {
  if (!apiKey && !client) throw new Error('OPENAI_API_KEY is not configured');
  const openai = client || new OpenAI({ apiKey });
  return {
    async generate({ prompt, negativePrompt, references, width, height, projection }) {
      if (projection !== 'equirectangular' || width !== 4096 || height !== 2048) {
        throw new Error('Unsupported 360° generation target');
      }
      if (!Array.isArray(references) || references.length !== 2 || !references.every(x => typeof x === 'string' && x.startsWith('https://'))) {
        throw new Error('Two verified floor-plan reference URLs are required');
      }
      // Images API cannot guarantee 4096x2048 or true spherical geometry.
      // Generate a landscape reference render, NOT a ready-to-publish panorama.
      const response = await openai.images.generate({
        model,
        prompt: [prompt, 'Avoid:', negativePrompt, 'Floor plan reference URLs (must be independently inspected; URLs in prompt do not constitute image conditioning):', ...references].join('\n'),
        size: '1536x1024',
        quality: 'high',
        n: 1
      });
      const encoded = response?.data?.[0]?.b64_json;
      if (!encoded) throw new Error('Image provider returned no inline image bytes');
      return { bytes: Buffer.from(encoded, 'base64'), mimeType: 'image/png', projectionVerified: false, renderType: 'PERSPECTIVE_REFERENCE_ONLY' };
    }
  };
}
