import { describe, it, expect, vi, afterEach } from 'vitest';
import { SmsService } from '../sms.service.js';
import { DealsRepository } from '../../deals/deals.repository.js';
afterEach(() => vi.restoreAllMocks());
describe('Actual payment currency in SMS', () => {
  it('labels TJS snapshot as TJS when the payment ledger stores USD', async () => {
    vi.spyOn(DealsRepository, 'getPaymentById').mockResolvedValue({ id: 501, deal_id: 51, currency: 'USD', amount_minor: 215983, amount_tjs: '20000.00', amount_usd: '2159.83', exchange_rate: '9.26', status: 'ACTIVE' });
    vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 51, lead_id: 17, currency: 'USD', final_price_minor: 4870800, payments: [{ amount_minor: 215983 }] });
    const context = await new SmsService().calculatePaymentContext(501, 51, 17);
    expect(context.paymentCurrency).toBe('TJS');
    expect(context.paymentAmountFormatted.replace(/\u00a0/g, ' ')).toBe('20 000');
    expect(context.contractCurrency).toBe('USD');
    expect(context.totalPaidMinor).toBe(215983);
    expect(context.remainingBalanceMinor).toBe(4654817);
  });
  it('keeps an ordinary USD receipt in USD', async () => {
    vi.spyOn(DealsRepository, 'getPaymentById').mockResolvedValue({ id: 502, deal_id: 51, currency: 'USD', amount_minor: 2000000, status: 'ACTIVE' });
    vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 51, lead_id: 17, currency: 'USD', payments: [] });
    const context = await new SmsService().calculatePaymentContext(502, 51, 17);
    expect(context.paymentCurrency).toBe('USD');
    expect(context.paymentAmountFormatted.replace(/\u00a0/g, ' ')).toBe('20 000');
    expect(context.isMultiCurrency).toBe(false);
  });
});
