import { REQUIRED_360_ROOMS } from './ai360SceneBrief.js';

/** Pure, read-only tour readiness check. No writes or automatic publication. */
export function evaluateTour360Readiness(panoramas = [], hotspots = []) {
  const rooms = new Map();
  for (const panorama of panoramas) {
    if (REQUIRED_360_ROOMS.includes(panorama.name)) {
      rooms.set(panorama.name, [...(rooms.get(panorama.name) || []), panorama]);
    }
  }
  const missingRooms = REQUIRED_360_ROOMS.filter(name => !rooms.has(name));
  const duplicateRooms = REQUIRED_360_ROOMS.filter(name => (rooms.get(name) || []).length > 1);
  const ids = new Set(panoramas.map(p => Number(p.id)));
  const edges = new Map([...ids].map(id => [id, new Set()]));
  const invalidNavigation = [];
  for (const hotspot of hotspots) {
    if (hotspot.hotspot_type !== 'NAVIGATION') continue;
    const source = Number(hotspot.panorama_id);
    const target = Number(hotspot.target_panorama_id);
    if (!ids.has(source) || !ids.has(target) || source === target) {
      invalidNavigation.push(hotspot.id);
      continue;
    }
    edges.get(source).add(target);
  }
  const start = panoramas.find(p => p.name === 'Коридор')?.id ?? panoramas[0]?.id;
  const visited = new Set();
  if (start != null) {
    const pending = [Number(start)];
    while (pending.length) {
      const current = pending.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of edges.get(current) || []) if (!visited.has(next)) pending.push(next);
    }
  }
  const unreachablePanoramaIds = panoramas.filter(p => !visited.has(Number(p.id))).map(p => p.id);
  return {
    required_rooms: [...REQUIRED_360_ROOMS],
    missing_rooms: missingRooms,
    duplicate_rooms: duplicateRooms,
    invalid_navigation_hotspots: invalidNavigation,
    unreachable_panorama_ids: unreachablePanoramaIds,
    navigation_ready: panoramas.length === REQUIRED_360_ROOMS.length &&
      missingRooms.length === 0 && duplicateRooms.length === 0 &&
      invalidNavigation.length === 0 && unreachablePanoramaIds.length === 0,
    note: 'Проверка связности ориентированного графа переходов. Геометрию помещений и изображения проверяют отдельно.'
  };
}
