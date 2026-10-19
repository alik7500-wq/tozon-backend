import { describe, it, expect } from 'vitest';
import { selectUnitTour } from './selectUnitTour.js';
const tour = { id: 30, project_id: 3, entity_type: 'UNIT', entity_id: 83, is_active: true };
describe('apartment tour isolation', () => {
  it('opens the exact active unit tour', () => expect(selectUnitTour([tour], '83')).toEqual(tour));
  it('does not expose unit 83 tour on another apartment', () => expect(selectUnitTour([tour], 84)).toBeNull());
  it('does not expose drafts', () => expect(selectUnitTour([{ ...tour, is_active: false }], 83)).toBeNull());
  it('does not substitute a building tour', () => expect(selectUnitTour([{ ...tour, entity_type: 'BUILDING' }], 83)).toBeNull());
});

const unit = { id: 110, unit_number: '34', layout_type_id: 11, area_m2_x100: 8180, rooms: 2,
  floors: { sections: { buildings: { id: 3, project_id: 3 } } } };
const source = { ...unit, id: 83, unit_number: '7' };
const showroom = { ...tour, tour_type: 'SHOWROOM' };
describe('same layout showroom', () => {
  it('offers the source tour as an explicitly labeled example for apartment 34', () => {
    expect(selectUnitTour([showroom], 110, unit, [source])).toEqual({ ...showroom,
      presentation_scope: 'LAYOUT', presentation_unit_id: 110, presentation_layout_id: 11, source_unit_number: '7' });
  });
  it('prefers a tour of the exact apartment', () => {
    const exact = { ...tour, id: 31, entity_id: 110 };
    expect(selectUnitTour([showroom, exact], 110, unit, [source])).toEqual(exact);
  });
  it.each([
    { ...source, layout_type_id: 12 },
    { ...source, area_m2_x100: 8181 },
    { ...source, rooms: 3 },
    { ...source, rooms: null },
    { ...source, archived_at: '2026-10-19' },
    { ...source, floors: { sections: { buildings: { id: 4, project_id: 3 } } } },
    { ...source, floors: { sections: { buildings: { id: 3, project_id: 4 } } } },
    { ...source, floors: null },
  ])('rejects a nonmatching or archived source: %j', mismatch => {
    expect(selectUnitTour([showroom], 110, unit, [mismatch])).toBeNull();
  });
  it.each([
    { ...showroom, is_active: false },
    { ...showroom, tour_type: 'EXTERIOR' },
    { ...showroom, project_id: 4 },
    { ...showroom, entity_type: 'BUILDING' },
  ])('rejects inactive, non-showroom or foreign tours: %j', mismatch => {
    expect(selectUnitTour([mismatch], 110, unit, [source])).toBeNull();
  });
  it('does not select a source when its apartment data is missing', () => {
    expect(selectUnitTour([showroom], 110, unit, [])).toBeNull();
  });
});
