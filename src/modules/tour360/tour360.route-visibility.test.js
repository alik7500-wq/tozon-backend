import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('360 draft route authorization ordering', () => {
  it('checks tour visibility before loading signed panorama URLs on both tour GET endpoints', () => {
    const source = readFileSync(new URL('./tour360.router.js', import.meta.url), 'utf8');
    const matches = [...source.matchAll(/const visibility = await Tour360Repository\.getTourVisibility\(req\.params\.tourId\);([\s\S]*?)const tour = await Tour360Repository\.getTourTree\(req\.params\.tourId\);/g)];
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(match[1]).toContain("throw new AppError('Тур не найден', 404)");
      expect(match[1]).toContain("['ADMIN', 'DIRECTOR']");
    }
  });
});
