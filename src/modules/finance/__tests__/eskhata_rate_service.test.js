import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EskhataRateService, parseEskhataUsdRates } from '../eskhata-rate.service.js';

describe('Eskhata Exchange Rate Architecture & Regression Tests', () => {
  beforeEach(() => {
    EskhataRateService.resetCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // TEST 1: HTML with current SVG Eskhata
  it('TEST 1: Parses live Eskhata HTML containing SVG vector paths correctly (buy 9.16, sell 9.26)', () => {
    const htmlWithSvg = `
      <div class="rates-table">
        <table>
          <tr>
            <td>
              <svg width="24" height="24" viewBox="0 0 24 24"><path fill="red" d="M12 2L2 22h20L12 2z"/></svg>
              <span>USD</span>
            </td>
            <td><span> 9.1600 </span></td>
            <td><span> 9.2600 </span></td>
            <td><span> 9.2404 </span></td>
          </tr>
        </table>
      </div>
    `;

    const result = parseEskhataUsdRates(htmlWithSvg);
    expect(result).not.toBeNull();
    expect(result.buyRate).toBe(9.16);
    expect(result.sellRate).toBe(9.26);
    expect(result.nbtRate).toBe(9.2404);
  });

  // TEST 2: HTML without SVG
  it('TEST 2: Parses standard HTML without SVG vector elements correctly', () => {
    const htmlWithoutSvg = `
      <tr>
        <td>USD</td>
        <td>9.1600</td>
        <td>9.2600</td>
        <td>9.2404</td>
      </tr>
    `;

    const result = parseEskhataUsdRates(htmlWithoutSvg);
    expect(result).not.toBeNull();
    expect(result.buyRate).toBe(9.16);
    expect(result.sellRate).toBe(9.26);
  });

  // TEST 3: Broken/changed USD row
  it('TEST 3: Fails safely on broken/malformed USD row and does NOT return hardcoded 9.27', () => {
    const brokenHtml = `
      <tr>
        <td>USD</td>
        <td>N/A</td>
        <td>Closed</td>
      </tr>
    `;

    const result = parseEskhataUsdRates(brokenHtml);
    expect(result).toBeNull();
  });

  // TEST 4: Live fetch failed + last-known-good exists
  it('TEST 4: Returns source="CACHE", isStale=true, and preserves previous updatedAt when live fetch fails but cache exists', async () => {
    const validHtml = `<tr><td>USD</td><td>9.1600</td><td>9.2600</td></tr>`;

    // 1. Successful initial fetch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(validHtml)
    }));

    const liveResult = await EskhataRateService.getEskhataUsdRate();
    expect(liveResult.available).toBe(true);
    expect(liveResult.source).toBe('ESKHATA_LIVE');
    expect(liveResult.isStale).toBe(false);
    expect(liveResult.sellRate).toBe(9.26);
    const initialUpdatedAt = liveResult.updatedAt;
    expect(initialUpdatedAt).toBeDefined();

    // Fast-forward fetch timer beyond CACHE_TTL_MS
    EskhataRateService.lastFetchTime = Date.now() - (EskhataRateService.CACHE_TTL_MS + 1000);

    // 2. Second fetch fails (network error)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network offline')));

    const staleResult = await EskhataRateService.getEskhataUsdRate();
    expect(staleResult.available).toBe(true);
    expect(staleResult.source).toBe('CACHE');
    expect(staleResult.isStale).toBe(true);
    expect(staleResult.sellRate).toBe(9.26);
    // updatedAt must be preserved from the last successful fetch!
    expect(staleResult.updatedAt).toBe(initialUpdatedAt);
  });

  // TEST 5: Live fetch failed + cache empty
  it('TEST 5: Returns available=false and source="UNAVAILABLE" when live fetch fails and no cache exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    const result = await EskhataRateService.getEskhataUsdRate();
    expect(result.available).toBe(false);
    expect(result.source).toBe('UNAVAILABLE');
    expect(result.isStale).toBe(true);
    expect(result.sellRate).toBeNull();
    expect(result.buyRate).toBeNull();
    expect(result.updatedAt).toBeNull();
    expect(result.error).toBe('Не удалось получить актуальный курс Эсхата');
  });

  // TEST 6: Live parse validation
  it('TEST 6: Live parsing live eskhata.com web HTML structure extracts exact current rates', async () => {
    const sampleWebHtml = `
      <table class="table">
        <tbody>
          <tr>
            <td><svg></svg> USD</td>
            <td>9.1600</td>
            <td>9.2600</td>
            <td>9.2404</td>
          </tr>
        </tbody>
      </table>
    `;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(sampleWebHtml)
    }));

    const rate = await EskhataRateService.getEskhataUsdRate();
    expect(rate.available).toBe(true);
    expect(rate.buyRate).toBe(9.16);
    expect(rate.sellRate).toBe(9.26);
    expect(rate.source).toBe('ESKHATA_LIVE');
    expect(rate.isStale).toBe(false);
  });
});
