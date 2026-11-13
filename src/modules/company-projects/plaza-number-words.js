// Preserved from TOZON CRM ContractPrintView.jsx.
export const numberToTajikWords = (num) => {
    if (!num || isNaN(num)) return '';
    num = Math.floor(Math.abs(num));
    if (num === 0) return 'сифр';

    const units = ['', 'як', 'ду', 'се', 'чор', 'панҷ', 'шаш', 'ҳафт', 'ҳашт', 'нӯҳ'];
    const teens = ['даҳ', 'ёздаҳ', 'дувоздаҳ', 'сенздаҳ', 'чордаҳ', 'понздаҳ', 'шонздаҳ', 'ҳафдаҳ', 'ҳаждаҳ', 'нуздаҳ'];
    const tens = ['', 'даҳ', 'бист', 'си', 'чил', 'панҷоҳ', 'шаст', 'ҳафтод', 'ҳаштод', 'навад'];
    const hundreds = ['', 'яксад', 'дусад', 'сесад', 'чорсад', 'панҷсад', 'шашсад', 'ҳафтсад', 'ҳаштсад', 'нӯҳсад'];

    const parts = [];

    if (num >= 1000000) {
      const millions = Math.floor(num / 1000000);
      parts.push(`${numberToTajikWords(millions)} миллион`);
      num %= 1000000;
    }

    if (num >= 1000) {
      const thousands = Math.floor(num / 1000);
      if (thousands === 1) {
        parts.push('як ҳазор');
      } else {
        parts.push(`${numberToTajikWords(thousands)} ҳазор`);
      }
      num %= 1000;
    }

    if (num >= 100) {
      const h = Math.floor(num / 100);
      parts.push(hundreds[h]);
      num %= 100;
    }

    if (num >= 10 && num <= 19) {
      parts.push(teens[num - 10]);
      num = 0;
    } else if (num >= 20) {
      const t = Math.floor(num / 10);
      parts.push(tens[t]);
      num %= 10;
    }

    if (num > 0) {
      parts.push(units[num]);
    }

    return parts.filter(Boolean).join('у ').replace(/у\s+ҳазор/g, ' ҳазор').replace(/у\s+миллион/g, ' миллион');
  };

  // Number to Words in Russian
export const numberToRussianWords = (num) => {
    if (!num || isNaN(num)) return '';
    num = Math.floor(Math.abs(num));
    if (num === 0) return 'ноль';

    const units = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
    const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
    const tens = ['', 'десять', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
    const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

    const parts = [];
    if (num >= 1000000) {
      const m = Math.floor(num / 1000000);
      parts.push(`${numberToRussianWords(m)} миллион(ов)`);
      num %= 1000000;
    }
    if (num >= 1000) {
      const th = Math.floor(num / 1000);
      if (th === 1) parts.push('одна тысяча');
      else if (th === 2) parts.push('две тысячи');
      else if (th >= 3 && th <= 4) parts.push(`${units[th]} тысячи`);
      else parts.push(`${numberToRussianWords(th)} тысяч`);
      num %= 1000;
    }
    if (num >= 100) {
      parts.push(hundreds[Math.floor(num / 100)]);
      num %= 100;
    }
    if (num >= 10 && num <= 19) {
      parts.push(teens[num - 10]);
      num = 0;
    } else if (num >= 20) {
      parts.push(tens[Math.floor(num / 10)]);
      num %= 10;
    }
    if (num > 0) {
      parts.push(units[num]);
    }
    return parts.filter(Boolean).join(' ');
  };
