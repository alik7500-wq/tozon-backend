import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('360 draft route authorization ordering', () => {
  it('checks tour visibility before loading signed panorama URLs on the tour detail endpoint', () => {
    const source = readFileSync(new URL('./tour360.router.js', import.meta.url), 'utf8');
    const detailRoute = source.split("router.get('/360-tours/:tourId',")[1]?.split("\n});")[0];
    expect(detailRoute).toBeTruthy();
    const visibility = detailRoute.indexOf('getTourVisibility(req.params.tourId)');
    const tree = detailRoute.indexOf('getTourTree(req.params.tourId)');
    expect(visibility).toBeGreaterThanOrEqual(0);
    expect(tree).toBeGreaterThan(visibility);
    expect(detailRoute).toContain("throw new AppError('Тур не найден', 404)");
    expect(detailRoute).toContain("['ADMIN', 'DIRECTOR']");
  });

  it('checks tour visibility before listing panoramas without loading the entire tour tree', () => {
    const source = readFileSync(new URL('./tour360.router.js', import.meta.url), 'utf8');
    const listRoute = source.split("router.get('/360-tours/:tourId/panoramas',")[1]?.split("\n});")[0];
    expect(listRoute).toBeTruthy();
    const visibility = listRoute.indexOf('getTourVisibility(req.params.tourId)');
    const panoramas = listRoute.indexOf('getPanoramas(req.params.tourId)');
    expect(visibility).toBeGreaterThanOrEqual(0);
    expect(panoramas).toBeGreaterThan(visibility);
    expect(listRoute).not.toContain('getTourTree(req.params.tourId)');
    expect(listRoute).toContain("throw new AppError('Тур не найден', 404)");
    expect(listRoute).toContain("['ADMIN', 'DIRECTOR']");
  });
});
