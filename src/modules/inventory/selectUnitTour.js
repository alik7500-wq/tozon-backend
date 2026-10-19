const building = unit => unit?.floors?.sections?.buildings;
const sameId = (a, b) => Number(a) > 0 && Number(b) > 0 && String(a) === String(b);

// Prefer an exact tour. A showroom can also illustrate the identical layout
// in the same building, with the source apartment explicitly identified.
export function selectUnitTour(tours, unitId, unit = null, sourceUnits = []) {
  const active = (tours || []).filter(t => t.is_active === true && t.entity_type === 'UNIT');
  const exact = active.find(t => sameId(t.entity_id, unitId));
  if (exact) return exact;
  if (!unit || !sameId(unit.id, unitId)) return null;
  const targetBuilding = building(unit);
  for (const tour of active) {
    if (tour.tour_type !== 'SHOWROOM' || !sameId(tour.project_id, targetBuilding?.project_id)) continue;
    const source = sourceUnits.find(u => sameId(u.id, tour.entity_id));
    if (!source || source.archived_at || unit.archived_at
      || !sameId(source.layout_type_id, unit.layout_type_id)
      || !sameId(building(source)?.id, targetBuilding?.id)
      || !sameId(building(source)?.project_id, targetBuilding?.project_id)
      || !sameId(source.area_m2_x100, unit.area_m2_x100)
      || source.rooms == null || unit.rooms == null || Number(source.rooms) !== Number(unit.rooms)) continue;
    return { ...tour, presentation_scope: 'LAYOUT', presentation_unit_id: unit.id,
      presentation_layout_id: unit.layout_type_id, source_unit_number: source.unit_number };
  }
  return null;
}
