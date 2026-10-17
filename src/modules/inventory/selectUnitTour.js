// Apartment cards may only open the tour explicitly assigned to this unit.
export function selectUnitTour(tours, unitId) {
  return (tours || []).find(t => t.is_active === true && t.entity_type === 'UNIT' && String(t.entity_id) === String(unitId)) || null;
}
