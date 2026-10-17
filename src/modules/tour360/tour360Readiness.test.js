import { describe, expect, it } from 'vitest';
import { evaluateTour360Readiness } from './tour360Readiness.js';

const names = ['Коридор', 'Гостиная', 'Спальня', 'Кухня', 'Санузел'];
const rooms = names.map((name, i) => ({ id: i + 1, name }));
const links = names.slice(1).flatMap((_, i) => [
  { id: i * 2 + 1, panorama_id: 1, target_panorama_id: i + 2, hotspot_type: 'NAVIGATION' },
  { id: i * 2 + 2, panorama_id: i + 2, target_panorama_id: 1, hotspot_type: 'NAVIGATION' }
]);
describe('five-room virtual tour readiness', () => {
  it('accepts a complete bidirectional hub tour', () => {
    expect(evaluateTour360Readiness(rooms, links).navigation_ready).toBe(true);
  });
  it('rejects missing rooms', () => {
    expect(evaluateTour360Readiness(rooms.slice(0, 4), links).missing_rooms).toContain('Санузел');
  });
  it('rejects disconnected rooms', () => {
    const result = evaluateTour360Readiness(rooms, links.filter(h => h.target_panorama_id !== 5 && h.panorama_id !== 5));
    expect(result.navigation_ready).toBe(false);
    expect(result.unreachable_panorama_ids).toContain(5);
  });
  it('rejects cross-tour or self-referencing links', () => {
    const result = evaluateTour360Readiness(rooms, [...links, { id: 99, panorama_id: 2, target_panorama_id: 999, hotspot_type: 'NAVIGATION' }]);
    expect(result.invalid_navigation_hotspots).toContain(99);
    expect(result.navigation_ready).toBe(false);
  });
});
