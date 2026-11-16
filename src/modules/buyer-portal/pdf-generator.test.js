import { it, expect } from 'vitest';
import { generateBuyerPdf } from './pdf-generator.js';

const sampleContract = {
  id: 1,
  contractNumber: '007',
  contractDate: '2026-10-15',
  status: 'SIGNED',
  archived: false,
  property: {
    projectName: 'TOZON PLAZA',
    buildingName: 'Б',
    sectionName: '1',
    floorNumber: 3,
    unitNumber: '7',
    areaM2x100: 8180,
    rooms: 2,
    pricePerM2Minor: 100000
  },
  manager: { name: 'Алишер' },
  company: { name: 'ТОЗОН', address: 'ш. Хуҷанд', phone: '+992 92 000 00 00' },
  summary: {
    currency: 'USD',
    totalMinor: 8180000,
    downPaymentMinor: 2000000,
    paidMinor: 3000000,
    remainingMinor: 5180000,
    barterCreditedMinor: 0,
    nextPayment: { date: '2026-12-01', amountMinor: 500000 }
  },
  schedules: [
    { id: 1, number: 1, dueDate: '2026-11-01', plannedMinor: 1000000, paidMinor: 1000000, remainingMinor: 0, status: 'PAID' },
    { id: 2, number: 2, dueDate: '2026-12-01', plannedMinor: 500000, paidMinor: 0, remainingMinor: 500000, status: 'UPCOMING' }
  ],
  history: [
    { id: 55, kind: 'PAYMENT', number: 'ПКО-55', date: '2026-11-01', amountMinor: 1000000, currency: 'USD', creditedMinor: 1000000, status: 'ACTIVE', method: 'CASH', purpose: 'Пардохти моҳона' }
  ]
};

it('generates valid PDF buffers for CONTRACT, SCHEDULE and RECEIPT in both Tajik and Russian', async () => {
  for (const language of ['tj', 'ru']) {
    const c = await generateBuyerPdf(sampleContract, { kind: 'CONTRACT', language });
    expect(c.mime).toBe('application/pdf');
    expect(c.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(c.buffer.length).toBeGreaterThan(2000);

    const s = await generateBuyerPdf(sampleContract, { kind: 'SCHEDULE', language });
    expect(s.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    const r = await generateBuyerPdf(sampleContract, { kind: 'RECEIPT', paymentId: 55, language });
    expect(r.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }
});

it('returns null for a foreign or non-existent paymentId', async () => {
  const foreign = await generateBuyerPdf(sampleContract, { kind: 'RECEIPT', paymentId: 9999, language: 'tj' });
  expect(foreign).toBeNull();
});
