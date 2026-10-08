import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { AppError } from '../../shared/errors/errorHandler.js';

export const TYPES = ['CONTRACT', 'ACT', 'PKO', 'RKO', 'SCHEDULE', 'RESERVATION', 'OFFER', 'APARTMENT'];
export const LANGUAGES = ['TJ', 'RU', 'UZ', 'EN'];
export const FIELDS = [
  'document_number', 'document_date', 'contract_number', 'contract_date',
  'client_name', 'client_phone', 'client_inn', 'passport_number', 'passport_issued_by',
  'passport_issue_date', 'client_address', 'birth_date', 'project_name', 'project_address',
  'building_name', 'section_name', 'floor_number', 'unit_number', 'rooms', 'area',
  'price_per_m2', 'contract_total', 'currency', 'down_payment', 'total_paid', 'remaining_debt',
  'payment_type', 'amount', 'amount_tjs', 'amount_usd', 'exchange_rate', 'amount_words',
  'payer_name', 'recipient_name', 'basis', 'attachment', 'cash_desk',
  'company_name', 'company_inn', 'company_address', 'company_phone', 'company_bank',
  'company_account', 'director_name', 'accountant_name', 'cashier_name', 'branch_name',
  'schedules', 'row_number', 'due_date', 'planned_amount', 'paid_amount', 'balance', 'status'
];
export const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Flat keys only: no expression evaluator, raw XML tags, inherited properties or scripts.
const parser = tag => {
  if (!FIELDS.includes(tag)) throw new AppError(`Неизвестная переменная: ${tag}. Используйте список переменных.`, 400);
  return { get: scope => Object.hasOwn(scope || {}, tag) ? scope[tag] : undefined };
};

export function compileTemplate(buffer) {
  if (!buffer?.length || buffer.length > 2 * 1024 * 1024) throw new AppError('Размер DOCX должен быть от 1 байта до 2 МБ', 400);
  try {
    const zip = new PizZip(buffer);
    const entries = Object.values(zip.files);
    let unpacked = 0;
    if (entries.length > 300) throw new Error('too many entries');
    for (const entry of entries) {
      const size = entry._data?.uncompressedSize || 0;
      unpacked += size;
      if (unpacked > 12 * 1024 * 1024) throw new Error('too large');
      if (/vbaProject|embeddings\//i.test(entry.name)) throw new Error('embedded object');
      if (/\.rels$/.test(entry.name) && /TargetMode\s*=\s*["']External["']/i.test(entry.asText())) throw new Error('external resource');
    }
    if (!zip.file('word/document.xml') || !zip.file('[Content_Types].xml')) throw new Error('not docx');
    return new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, parser, nullGetter: () => '—' });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Некорректный бланк DOCX: проверьте переменные и пары {#schedules}…{/schedules}. Макросы, вложенные объекты и внешние ссылки не поддерживаются.', 400);
  }
}

export function cleanContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Данные документа обязательны', 400);
  const result = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (!FIELDS.includes(key)) throw new AppError(`Неизвестная переменная: ${key}`, 400);
    if (key === 'schedules') {
      if (!Array.isArray(value) || value.length > 600) throw new AppError('Некорректный график', 400);
      result[key] = value.map(row => {
        if (row?.schedules !== undefined) throw new AppError('Вложенный график запрещён', 400);
        return cleanContext(row);
      });
    } else {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new AppError('Переменные должны быть текстом или числом', 400);
      if (String(value ?? '').length > 10000) throw new AppError('Значение переменной слишком длинное', 400);
      result[key] = value ?? '—';
    }
  }
  return result;
}

export function renderTemplate(buffer, input) {
  const doc = compileTemplate(buffer);
  try { doc.render(cleanContext(input)); return doc.toBuffer(); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError('Не удалось заполнить бланк. Проверьте переменные и график.', 400); }
}

export function sampleTemplate(type) {
  const zip = new PizZip();
  const paragraphs = [
    `TOZON — ${type}`, '{company_name}', '{company_address}',
    'Документ № {document_number} от {document_date}',
    'Договор № {contract_number} от {contract_date}',
    'Клиент: {client_name}. Телефон: {client_phone}',
    'Паспорт: {passport_number}, {passport_issued_by}, {passport_issue_date}',
    'Адрес: {client_address}. ИНН: {client_inn}',
    '{project_name}, {building_name}, этаж {floor_number}, квартира {unit_number}',
    'Площадь: {area} м². Цена м²: {price_per_m2} {currency}',
    'Стоимость: {contract_total} {currency}. Оплачено: {total_paid}. Остаток: {remaining_debt}',
    'Сумма операции: {amount}. Сомони: {amount_tjs}. USD: {amount_usd}. Курс: {exchange_rate}',
    '{amount_words}', 'Основание: {basis}',
    ...(type === 'SCHEDULE' ? ['{#schedules}', '{row_number}. {due_date} — план {planned_amount}, факт {paid_amount}, остаток {balance}', '{/schedules}'] : []),
    'Руководитель: {director_name} __________', 'Бухгалтер: {accountant_name} __________'
  ];
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(p => `<w:p><w:r><w:t xml:space="preserve">${escape(p)}</w:t></w:r></w:p>`).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
