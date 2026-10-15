import { describe, expect, it } from 'vitest';
import { validatePanoramaDimensions } from './ai360GenerationService.js';

function jpeg(width, height) {
  return Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,(height>>8)&255,height&255,(width>>8)&255,width&255,3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xd9]);
}
function webpVp8x(width, height) {
  const b = Buffer.alloc(30);
  b.write('RIFF',0); b.write('WEBP',8); b.write('VP8X',12);
  b.writeUIntLE(width-1,24,3); b.writeUIntLE(height-1,27,3);
  return b;
}
describe('AI 360 image geometry validation', () => {
  it('accepts 4096x2048 JPEG and WEBP headers', () => {
    expect(validatePanoramaDimensions(jpeg(4096,2048),'image/jpeg')).toEqual({width:4096,height:2048});
    expect(validatePanoramaDimensions(webpVp8x(4096,2048),'image/webp')).toEqual({width:4096,height:2048});
  });
  it('rejects ordinary perspective images', () => {
    expect(() => validatePanoramaDimensions(jpeg(1536,1024),'image/jpeg')).toThrow('2:1');
    expect(() => validatePanoramaDimensions(webpVp8x(2048,2048),'image/webp')).toThrow('2:1');
  });
  it('rejects undersized and malformed files', () => {
    expect(() => validatePanoramaDimensions(jpeg(1024,512),'image/jpeg')).toThrow('2:1');
    expect(() => validatePanoramaDimensions(Buffer.from('bad'),'image/webp')).toThrow('2:1');
  });
});
