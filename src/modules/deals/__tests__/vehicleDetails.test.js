import { describe, it, expect } from 'vitest';
import { validateVehicleDetails } from '../vehicleDetails.validation.js';
const sample = { brand_model: 'Test Model', production_year: '2021', color: 'Белый', registration_number: 'TEST', vin: 'TESTVIN', registration_certificate: 'CERT', mileage_km: '0', handover_date: '2026-10-22', condition: 'Состояние', accessories: 'Два ключа', encumbrances: 'Нет' };
describe('vehicle details validation', () => {
 it('retains every entered field and zero mileage', () => expect(validateVehicleDetails(sample)).toEqual(sample));
 it('trims data and permits incomplete details without inventing facts', () => expect(validateVehicleDetails({ brand_model: '  Test Model  ', color: '' })).toEqual({ brand_model: 'Test Model' }));
 it.each([undefined,null,{}])('supports older/no-car payload %s', value => expect(validateVehicleDetails(value)).toBeNull());
 it.each([[], 'car', { engine_number: 'not-collected' }, { unknown: 'x' }, { color: {} }, { production_year: '9999' }, { production_year: 'test' }, { mileage_km: '-1' }, { mileage_km: '1.5' }, { handover_date: '2026-02-30' }, { handover_date: 'invalid' }, { condition: 'x'.repeat(1001) }])('rejects invalid data before persistence: %j', value => expect(() => validateVehicleDetails(value)).toThrow());
});
