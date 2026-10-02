// Utility to convert numbers to written words in Tajik (TJ) and Russian (RU)

const UNITS_RU = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const UNITS_RU_FEMALE = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS_RU = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS_RU = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS_RU = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

const UNITS_TJ = ['', 'як', 'ду', 'се', 'чор', 'панҷ', 'шаш', 'ҳафт', 'ҳашт', 'нӯҳ'];
const TEENS_TJ = ['даҳ', 'ёздаҳ', 'дувоздаҳ', 'сенздаҳ', 'чордаҳ', 'понздаҳ', 'шонздаҳ', 'ҳабдаҳ', 'ҳаждаҳ', 'нуздаҳ'];
const TENS_TJ = ['', '', 'бист', 'сӣ', 'чил', 'панҷоҳ', 'шаст', 'ҳафтод', 'ҳаштод', 'навад'];
const HUNDREDS_TJ = ['', 'яксад', 'дусад', 'сесад', 'чорсад', 'панҷсад', 'шашсад', 'ҳафтсад', 'ҳаштсад', 'нӯҳсад'];

function formatHundredsRU(num, isFemale = false) {
  const parts = [];
  const h = Math.floor(num / 100);
  const t = Math.floor((num % 100) / 10);
  const u = num % 10;

  if (h > 0) parts.push(HUNDREDS_RU[h]);

  if (t === 1) {
    parts.push(TEENS_RU[u]);
  } else {
    if (t > 1) parts.push(TENS_RU[t]);
    if (u > 0) parts.push(isFemale ? UNITS_RU_FEMALE[u] : UNITS_RU[u]);
  }

  return parts.join(' ');
}

function formatThousandsRU(num, forms) {
  if (num === 0) return '';
  const str = formatHundredsRU(num, forms[3] === 'female');
  const t = Math.floor((num % 100) / 10);
  const u = num % 10;

  let form = forms[2]; // 5+ (тысяч)
  if (t !== 1) {
    if (u === 1) form = forms[0]; // 1 (тысяча)
    else if (u >= 2 && u <= 4) form = forms[1]; // 2-4 (тысячи)
  }

  return `${str} ${form}`.trim();
}

export function numberToWordsRU(amount, currency = 'USD') {
  const num = Math.floor(Math.abs(amount));
  const cents = Math.round((Math.abs(amount) - num) * 100);

  if (num === 0) {
    return `ноль ${getCurrencyNameRU(0, currency)} ${String(cents).padStart(2, '0')} ${getCentsNameRU(cents, currency)}`;
  }

  const millions = Math.floor(num / 1000000);
  const thousands = Math.floor((num % 1000000) / 1000);
  const remainder = num % 1000;

  const parts = [];
  if (millions > 0) {
    parts.push(formatThousandsRU(millions, ['миллион', 'миллиона', 'миллионов', 'male']));
  }
  if (thousands > 0) {
    parts.push(formatThousandsRU(thousands, ['тысяча', 'тысячи', 'тысяч', 'female']));
  }
  if (remainder > 0) {
    const isFemale = currency === 'RUB' ? false : false;
    parts.push(formatHundredsRU(remainder, isFemale));
  }

  const curName = getCurrencyNameRU(num, currency);
  const centsStr = String(cents).padStart(2, '0');
  const centsName = getCentsNameRU(cents, currency);

  return `${parts.join(' ')} ${curName} ${centsStr} ${centsName}`.trim();
}

function getCurrencyNameRU(num, currency) {
  const cur = (currency || 'USD').toUpperCase();
  const t = Math.floor((num % 100) / 10);
  const u = num % 10;

  if (cur === 'TJS') {
    return 'сомони';
  } else if (cur === 'RUB') {
    if (t !== 1 && u === 1) return 'рубль';
    if (t !== 1 && u >= 2 && u <= 4) return 'рубля';
    return 'рублей';
  } else {
    // USD
    if (t !== 1 && u === 1) return 'доллар США';
    if (t !== 1 && u >= 2 && u <= 4) return 'доллара США';
    return 'долларов США';
  }
}

function getCentsNameRU(cents, currency) {
  const cur = (currency || 'USD').toUpperCase();
  if (cur === 'TJS') return 'дирамов';
  if (cur === 'RUB') return 'копеек';
  return 'центов';
}

// TAJIK NUMBER TO WORDS
function formatHundredsTJ(num) {
  const parts = [];
  const h = Math.floor(num / 100);
  const t = Math.floor((num % 100) / 10);
  const u = num % 10;

  if (h > 0) {
    parts.push(HUNDREDS_TJ[h]);
  }

  if (t === 1) {
    parts.push(TEENS_TJ[u]);
  } else {
    if (t > 1) {
      if (u > 0) {
        // e.g. 37 -> сӣу ҳафт
        parts.push(`${TENS_TJ[t]}у ${UNITS_TJ[u]}`);
      } else {
        parts.push(TENS_TJ[t]);
      }
    } else if (u > 0) {
      parts.push(UNITS_TJ[u]);
    }
  }

  return parts.join(' ');
}

export function numberToWordsTJ(amount, currency = 'USD') {
  const num = Math.floor(Math.abs(amount));
  const cents = Math.round((Math.abs(amount) - num) * 100);

  if (num === 0) {
    return `нол ${getCurrencyNameTJ(currency)} ${String(cents).padStart(2, '0')} ${getCentsNameTJ(currency)}`;
  }

  const millions = Math.floor(num / 1000000);
  const thousands = Math.floor((num % 1000000) / 1000);
  const remainder = num % 1000;

  const parts = [];

  if (millions > 0) {
    const mStr = formatHundredsTJ(millions);
    parts.push(`${mStr} миллион`);
  }

  if (thousands > 0) {
    const thStr = formatHundredsTJ(thousands);
    parts.push(`${thStr} ҳазор`);
  }

  if (remainder > 0) {
    const rStr = formatHundredsTJ(remainder);
    if (parts.length > 0) {
      parts.push(`у ${rStr}`);
    } else {
      parts.push(rStr);
    }
  }

  // Clean connectors: e.g. "ҳазор у яксад" -> "ҳазору як саду"
  let fullStr = parts.join(' ')
    .replace(/ҳазор у /g, 'ҳазору ')
    .replace(/яксад /g, 'як саду ')
    .replace(/дусад /g, 'ду саду ')
    .replace(/сесад /g, 'се саду ')
    .replace(/чорсад /g, 'чор саду ')
    .replace(/панҷсад /g, 'панҷ саду ')
    .replace(/шашсад /g, 'шаш саду ')
    .replace(/ҳафтсад /g, 'ҳафт саду ')
    .replace(/ҳаштсад /g, 'ҳашт саду ')
    .replace(/нӯҳсад /g, 'нӯҳ саду ')
    .replace(/\s+/g, ' ')
    .trim();

  const curName = getCurrencyNameTJ(currency);
  const centsStr = String(cents).padStart(2, '0');
  const centsName = getCentsNameTJ(currency);

  return `${fullStr} ${curName} ${centsStr} ${centsName}`.trim();
}

function getCurrencyNameTJ(currency) {
  const cur = (currency || 'USD').toUpperCase();
  if (cur === 'TJS') return 'сомонӣ';
  if (cur === 'RUB') return 'рубли русӣ';
  return 'доллари ИМА';
}

function getCentsNameTJ(currency) {
  const cur = (currency || 'USD').toUpperCase();
  if (cur === 'TJS') return 'дирам';
  if (cur === 'RUB') return 'тин';
  return 'сент';
}
