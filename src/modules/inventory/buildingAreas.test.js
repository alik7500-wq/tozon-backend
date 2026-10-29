import { it, expect } from 'vitest';
import { validateBuildingAreas } from './buildingAreas.js';

it('accepts precise integer areas and explicit unknown values', () => {
  expect(validateBuildingAreas({ footprint_area_m2_x100: 59500, gross_floor_area_m2_x100: null })).toEqual({ footprint_area_m2_x100: 59500, gross_floor_area_m2_x100: null });
});
it.each([{}, [], null, { name: 'renamed' }, { footprint_area_m2_x100: 0 }, { footprint_area_m2_x100: -1 }, { footprint_area_m2_x100: '59500' }, { footprint_area_m2_x100: 1.5 }, { gross_floor_area_m2_x100: 2147483648 }])('rejects an invalid area patch: %j', body => {
  expect(() => validateBuildingAreas(body)).toThrow();
});
