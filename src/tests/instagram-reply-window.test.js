import { describe, expect, it } from 'vitest';

// Reply window must use the earlier of the webhook receipt and Meta event time.
function allowed(messageTimestamp, receivedAt, now) {
  const raw = Number(messageTimestamp);
  const eventAt = Number.isFinite(raw) && raw > 0 ? (raw < 1e11 ? raw * 1000 : raw) : NaN;
  const last = Math.min(Date.parse(receivedAt), eventAt);
  return Number.isFinite(last) && last <= now && now - last < 86400000;
}
describe('Instagram Direct conservative reply window', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  it('accepts a recent actual inbound event', () => {
    expect(allowed(now - 60000, '2026-11-02T11:59:30Z', now)).toBe(true);
  });
  it('rejects a delayed webhook whose Meta event is too old', () => {
    expect(allowed(now - 90000000, '2026-11-02T11:59:30Z', now)).toBe(false);
  });
  it('rejects missing or future timestamps', () => {
    expect(allowed(null, '2026-11-02T11:59:30Z', now)).toBe(false);
    expect(allowed(now + 1000, '2026-11-02T12:00:01Z', now)).toBe(false);
  });
  it('accepts Meta seconds timestamps', () => {
    expect(allowed(Math.floor((now - 60000) / 1000), '2026-11-02T11:59:30Z', now)).toBe(true);
  });
});
