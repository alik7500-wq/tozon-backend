const number = new Intl.NumberFormat('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2});
export const formatNumber = value => number.format(Number(value));
export function formatDescription(value) {
 return String(value || '').replace(/(\d+[.,]\d+)(?=\s*(?:TJS|USD|RUB)\b)/g, value => formatNumber(value.replace(',', '.')))
  .replace(/((?:по курсу|курс)[:\s]+)(\d+(?:[.,]\d+)?)/gi, (_, prefix, value) => prefix + formatNumber(value.replace(',', '.')));
}
