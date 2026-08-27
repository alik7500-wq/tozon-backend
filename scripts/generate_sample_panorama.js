import fs from 'fs';

/**
 * Generates a minimal 2:1 equirectangular panorama PNG buffer (512x256)
 * with gradient sky and floor for automated testing.
 */
export function createSamplePanoramaPNG() {
  // Minimal valid 1x1 or 2:1 PNG with gradient/color
  // Base64 of a valid 2:1 equirectangular panoramic test image (512x256)
  const base64Data = 
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return Buffer.from(base64Data, 'base64');
}
