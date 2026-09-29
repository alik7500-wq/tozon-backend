/**
 * Safely parse USD exchange rates from raw Eskhata HTML text.
 * Strips SVG vector elements/noise, extracts the USD row/block, and validates rates.
 */
export function parseEskhataUsdRates(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return null;

  try {
    // 1. Strip all <svg ...>...</svg> blocks to eliminate SVG attributes and embedded text noise
    const cleanHtml = rawHtml.replace(/<svg[\s\S]*?<\/svg>/gi, '');

    // 2. Locate USD table row or block (e.g. <tr> ... USD ... </tr>)
    const trRegex = /<tr[^>]*>[\s\S]*?USD[\s\S]*?<\/tr>/gi;
    let match = trRegex.exec(cleanHtml);
    let usdBlock = match ? match[0] : null;

    if (!usdBlock) {
      // Secondary fallback: find "USD" and grab up to 500 characters after it
      const usdIndex = cleanHtml.indexOf('USD');
      if (usdIndex !== -1) {
        usdBlock = cleanHtml.slice(usdIndex, usdIndex + 500);
      }
    }

    if (!usdBlock) return null;

    // 3. Extract floating point numbers (e.g., 9.1600, 9.2600, 9.2404 or 9,16)
    const numberMatches = usdBlock.match(/\b\d{1,2}[.,]\d{2,4}\b/g);
    if (!numberMatches || numberMatches.length < 2) return null;

    const buy = parseFloat(numberMatches[0].replace(',', '.'));
    const sell = parseFloat(numberMatches[1].replace(',', '.'));
    const nbt = numberMatches[2] ? parseFloat(numberMatches[2].replace(',', '.')) : null;

    // 4. Validate bounds & sanity: buy > 5 && buy < 30, sell > 5 && sell < 30, sell >= buy
    if (
      Number.isFinite(buy) &&
      Number.isFinite(sell) &&
      buy > 5 &&
      buy < 30 &&
      sell > 5 &&
      sell < 30 &&
      sell >= buy
    ) {
      return { buyRate: buy, sellRate: sell, nbtRate: nbt };
    }

    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Сервис получения актуального курса валют Банка Эсхата (USD / TJS Продажа)
 */
export class EskhataRateService {
  static lastKnownGood = null;
  static lastFetchTime = 0;
  static CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes cache

  /**
   * Сбросить кэш (для тестирования)
   */
  static resetCache() {
    this.lastKnownGood = null;
    this.lastFetchTime = 0;
  }

  /**
   * Получить курс продажи/покупки USD Банка Эсхата
   */
  static async getEskhataUsdRate() {
    const now = Date.now();

    // 1. Извлечь из кэша, если с момента успешного запроса прошло меньше 15 минут
    if (
      this.lastKnownGood &&
      now - this.lastFetchTime < this.CACHE_TTL_MS
    ) {
      return {
        available: true,
        bank: 'Банк Эсхата',
        currency: 'USD',
        baseCurrency: 'TJS',
        buyRate: this.lastKnownGood.buyRate,
        sellRate: this.lastKnownGood.sellRate,
        updatedAt: this.lastKnownGood.updatedAt,
        source: this.lastKnownGood.source || 'ESKHATA_LIVE',
        isStale: false
      };
    }

    // 2. Попытка живого запроса к eskhata.com
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const response = await fetch('https://eskhata.com', {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const html = await response.text();
        const parsed = parseEskhataUsdRates(html);

        if (parsed) {
          const updatedAt = new Date().toISOString();
          this.lastKnownGood = {
            buyRate: parsed.buyRate,
            sellRate: parsed.sellRate,
            nbtRate: parsed.nbtRate || null,
            updatedAt,
            source: 'ESKHATA_LIVE'
          };
          this.lastFetchTime = now;

          return {
            available: true,
            bank: 'Банк Эсхата',
            currency: 'USD',
            baseCurrency: 'TJS',
            buyRate: parsed.buyRate,
            sellRate: parsed.sellRate,
            updatedAt,
            source: 'ESKHATA_LIVE',
            isStale: false
          };
        }
      }
    } catch (err) {
      console.warn('Live Eskhata rate fetch warning:', err.message);
    }

    // 3. Если живой запрос не удался, но есть last-known-good:
    if (this.lastKnownGood) {
      return {
        available: true,
        bank: 'Банк Эсхата',
        currency: 'USD',
        baseCurrency: 'TJS',
        buyRate: this.lastKnownGood.buyRate,
        sellRate: this.lastKnownGood.sellRate,
        updatedAt: this.lastKnownGood.updatedAt, // Сохраняем дату ПОСЛЕДНЕГО УСПЕШНОГО обновления
        source: 'CACHE',
        isStale: true,
        warning: 'Курс временно недоступен. Используется последний сохранённый курс.'
      };
    }

    // 4. Если нет кэша и живой запрос не удался:
    return {
      available: false,
      bank: 'Банк Эсхата',
      currency: 'USD',
      baseCurrency: 'TJS',
      buyRate: null,
      sellRate: null,
      updatedAt: null,
      source: 'UNAVAILABLE',
      isStale: true,
      error: 'Не удалось получить актуальный курс Эсхата'
    };
  }
}

