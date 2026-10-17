import { describe, it, expect } from 'vitest';
import { selectUnitTour } from './selectUnitTour.js';
const tour = { id: 30, project_id: 3, entity_type: 'UNIT', entity_id: 83, is_active: true };
describe('apartment tour isolation', () => {
  it('opens the exact active unit tour', () => expect(selectUnitTour([tour], '83')).toEqual(tour));
  it('does not expose unit 83 tour on another apartment', () => expect(selectUnitTour([tour], 84)).toBeNull());
  it('does not expose drafts', () => expect(selectUnitTour([{ ...tour, is_active: false }], 83)).toBeNull());
  it('does not substitute a building tour', () => expect(selectUnitTour([{ ...tour, entity_type: 'BUILDING' }], 83)).toBeNull());
});
