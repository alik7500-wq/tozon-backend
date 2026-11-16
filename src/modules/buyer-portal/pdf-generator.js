import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const FONT_REGULAR = join(fontDir, 'DejaVuSans.ttf');
const FONT_BOLD = join(fontDir, 'DejaVuSans-Bold.ttf');

const fmtMoney = (minor, currency) => {
  if (minor === null || minor === undefined) return '—';
  return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)} ${currency}`;
};

const fmtDate = (value) => {
  if (!value) return '—';
  const str = String(value).split('T')[0];
  const parts = str.split('-');
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return str;
};

const cleanCompany = (rawName, isTJ) => {
  let name = String(rawName || 'TOZON')
    .replace(/^(ООО|ҶДММ|ЗАО|ҶСК|ЧДММ|ЖДММ)\s*["«']?|["»']$/gi, '')
    .replace(/^["«']+|["»']+$/g, '')
    .trim();
  if (!name) name = 'TOZON';
  return isTJ ? `ҶДММ «${name}»` : `ООО «${name}»`;
};

const T = {
  tj: {
    contractTitle: 'МАЪЛУМОТНОМАИ ШАРТНОМА',
    scheduleTitle: 'ҶАДВАЛИ ПАРДОХТИ РАССРОЧКА',
    pkoTitle: 'ОРДЕРИ ДАРОМАДИ ХАЗИНАВӢ (ПКО)',
    electronicNote: 'Нусхаи электронӣ аз низоми TOZON CRM',
    contractNo: 'Шартнома №',
    fromDate: 'аз',
    status: 'Ҳолат',
    signed: 'Имзошуда',
    cancelled: 'Бекоршуда',
    project: 'Маҷмааи истиқоматӣ',
    building: 'Блок',
    section: 'Даромадгоҳ',
    floor: 'Ошёна',
    unit: 'Хона',
    area: 'Масоҳат',
    rooms: 'Ҳуҷраҳо',
    manager: 'Менеҷери масъул',
    totalPrice: 'Арзиши шартнома',
    pricePerM2: 'Нарх барои 1 м²',
    downPayment: 'Пешпардохт',
    paidTotal: 'Пардохт шудааст',
    remaining: 'Боқимондаи қарз',
    barter: 'Бартер ба ҳисоб гирифта шуд',
    nextPayment: 'Пардохти навбатӣ',
    colNo: '№',
    colDate: 'Сана',
    colPlanned: 'Нақша',
    colPaid: 'Пардохт',
    colRemaining: 'Боқимонда',
    colStatus: 'Ҳолат',
    rowStatus: { PAID: 'Пардохт шуд', PARTIAL: 'Қисман', UPCOMING: 'Интизор', OVERDUE: 'Муҳлатгузашта' },
    pkoNo: 'Ҳуҷҷат №',
    pkoDate: 'Санаи пардохт',
    pkoBasis: 'Асос / Таъинот',
    pkoBasisDefault: 'Пардохт тибқи шартномаи хариду фурӯш',
    pkoAmount: 'Маблағи пардохт',
    pkoCredited: 'Ба ҳисоби шартнома',
    pkoSnapshotTjs: 'Эквивалент (TJS)',
    pkoMethod: 'Усули пардохт',
    pkoStatus: 'Ҳолати пардохт',
    methods: { CASH: 'Нақдӣ', BANK: 'Бонк', BANK_TRANSFER: 'Интиқоли бонкӣ', CARD: 'Корти бонкӣ', NON_CASH_BARTER: 'Бартер', TRANSFER: 'Интиқол', OTHER: 'Дигар' },
    payStatuses: { ACTIVE: 'Ба ҳисоб гирифта шуд', POSTED: 'Ба ҳисоб гирифта шуд', VOIDED: 'Бекор шудааст', PENDING: 'Дар санҷиш' },
    noSchedule: 'Ҷадвали пардохт мавҷуд нест.'
  },
  ru: {
    contractTitle: 'ВЫПИСКА ПО ДОГОВОРУ',
    scheduleTitle: 'ГРАФИК РАССРОЧКИ ПЛАТЕЖЕЙ',
    pkoTitle: 'ПРИХОДНЫЙ КАССОВЫЙ ОРДЕР (ПКО)',
    electronicNote: 'Электронная копия из системы TOZON CRM',
    contractNo: 'Договор №',
    fromDate: 'от',
    status: 'Статус',
    signed: 'Подписан',
    cancelled: 'Расторгнут',
    project: 'Жилой комплекс',
    building: 'Блок',
    section: 'Подъезд',
    floor: 'Этаж',
    unit: 'Квартира',
    area: 'Площадь',
    rooms: 'Комнаты',
    manager: 'Ответственный менеджер',
    totalPrice: 'Стоимость договора',
    pricePerM2: 'Цена за 1 м²',
    downPayment: 'Первоначальный взнос',
    paidTotal: 'Оплачено',
    remaining: 'Остаток задолженности',
    barter: 'Бартер учтён',
    nextPayment: 'Следующий платёж',
    colNo: '№',
    colDate: 'Дата',
    colPlanned: 'По плану',
    colPaid: 'Оплачено',
    colRemaining: 'Остаток',
    colStatus: 'Статус',
    rowStatus: { PAID: 'Оплачено', PARTIAL: 'Частично', UPCOMING: 'Ожидается', OVERDUE: 'Просрочен' },
    pkoNo: 'Документ №',
    pkoDate: 'Дата платежа',
    pkoBasis: 'Основание / Назначение',
    pkoBasisDefault: 'Оплата по договору купли-продажи недвижимости',
    pkoAmount: 'Сумма платежа',
    pkoCredited: 'В зачёт договора',
    pkoSnapshotTjs: 'Эквивалент (TJS)',
    pkoMethod: 'Способ оплаты',
    pkoStatus: 'Статус платежа',
    methods: { CASH: 'Наличные', BANK: 'Банк', BANK_TRANSFER: 'Банковский перевод', CARD: 'Банковская карта', NON_CASH_BARTER: 'Бартер', TRANSFER: 'Перевод', OTHER: 'Прочее' },
    payStatuses: { ACTIVE: 'Учтён', POSTED: 'Учтён', VOIDED: 'Аннулирован', PENDING: 'Проверяется' },
    noSchedule: 'График рассрочки отсутствует.'
  }
};

function renderPdfBuffer(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Producer: 'TOZON CRM', Creator: 'TOZON CRM' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('Regular', FONT_REGULAR);
    doc.registerFont('Bold', FONT_BOLD);
    doc.font('Regular');
    buildFn(doc);
    doc.end();
  });
}

function drawHeader(doc, title, contract, lang) {
  const isTJ = lang === 'tj';
  const t = T[isTJ ? 'tj' : 'ru'];
  const org = cleanCompany(contract.company?.name, isTJ);
  doc.font('Bold').fontSize(14).fillColor('#0f172a').text(org, { align: 'left' });
  if (contract.company?.address || contract.company?.phone) {
    doc.font('Regular').fontSize(8.5).fillColor('#475569').text(
      [contract.company.address, contract.company.phone].filter(Boolean).join(' · ')
    );
  }
  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#cbd5e1').lineWidth(1).stroke();
  doc.moveDown(0.7);
  doc.font('Bold').fontSize(13).fillColor('#0f172a').text(title, { align: 'center' });
  doc.font('Regular').fontSize(9).fillColor('#64748b').text(
    `${t.contractNo}${contract.contractNumber} ${t.fromDate} ${fmtDate(contract.contractDate)} · ${t.electronicNote}`,
    { align: 'center' }
  );
  doc.moveDown(0.8);
}

function drawKeyValueRows(doc, rows) {
  const startX = 40;
  const labelW = 190;
  const valueW = 325;
  for (const [label, value] of rows) {
    if (doc.y > 750) doc.addPage();
    const y = doc.y;
    doc.font('Regular').fontSize(9.5).fillColor('#475569').text(label, startX, y, { width: labelW });
    doc.font('Bold').fontSize(9.5).fillColor('#0f172a').text(String(value ?? '—'), startX + labelW, y, { width: valueW });
    doc.y = Math.max(doc.y, y + 16) + 2;
  }
}

function drawScheduleTable(doc, contract, lang) {
  const t = T[lang === 'tj' ? 'tj' : 'ru'];
  const cur = contract.summary?.currency || 'USD';
  const rows = contract.schedules || [];
  if (!rows.length) {
    doc.font('Regular').fontSize(10).fillColor('#475569').text(t.noSchedule);
    return;
  }
  const cols = [
    { label: t.colNo, x: 40, w: 30 },
    { label: t.colDate, x: 70, w: 75 },
    { label: t.colPlanned, x: 145, w: 95 },
    { label: t.colPaid, x: 240, w: 95 },
    { label: t.colRemaining, x: 335, w: 95 },
    { label: t.colStatus, x: 430, w: 125 }
  ];
  const drawTableHeader = () => {
    const y = doc.y;
    doc.rect(40, y - 3, 515, 18).fill('#0f172a');
    doc.font('Bold').fontSize(8.5).fillColor('#ffffff');
    for (const c of cols) doc.text(c.label, c.x + 3, y + 1, { width: c.w - 6 });
    doc.y = y + 18;
  };
  drawTableHeader();
  rows.forEach((r, idx) => {
    if (doc.y > 760) {
      doc.addPage();
      drawTableHeader();
    }
    const y = doc.y;
    if (idx % 2 === 1) doc.rect(40, y - 2, 515, 16).fill('#f8fafc');
    doc.font('Regular').fontSize(8.5).fillColor('#0f172a');
    doc.text(String(r.number), cols[0].x + 3, y, { width: cols[0].w - 6 });
    doc.text(fmtDate(r.dueDate), cols[1].x + 3, y, { width: cols[1].w - 6 });
    doc.text(fmtMoney(r.plannedMinor, cur), cols[2].x + 3, y, { width: cols[2].w - 6 });
    doc.text(fmtMoney(r.paidMinor, cur), cols[3].x + 3, y, { width: cols[3].w - 6 });
    doc.text(fmtMoney(r.remainingMinor, cur), cols[4].x + 3, y, { width: cols[4].w - 6 });
    doc.text(t.rowStatus[r.status] || r.status, cols[5].x + 3, y, { width: cols[5].w - 6 });
    doc.y = y + 16;
  });
}

export async function generateBuyerPdf(contract, { kind, paymentId, language = 'tj' }) {
  const lang = language === 'ru' ? 'ru' : 'tj';
  const t = T[lang];
  const p = contract.property || {};
  const s = contract.summary || {};
  const cur = s.currency || 'USD';

  if (kind === 'CONTRACT') {
    const buffer = await renderPdfBuffer((doc) => {
      drawHeader(doc, t.contractTitle, contract, lang);
      drawKeyValueRows(doc, [
        [t.status, contract.status === 'CANCELLED' ? t.cancelled : t.signed],
        [t.project, p.projectName || '—'],
        [t.building, p.buildingName || '—'],
        [t.section, p.sectionName || '—'],
        [t.floor, p.floorNumber ?? '—'],
        [t.unit, p.unitNumber ? `№${p.unitNumber}` : '—'],
        [t.area, p.areaM2x100 !== null && p.areaM2x100 !== undefined ? `${(p.areaM2x100 / 100).toFixed(2)} м²` : '—'],
        [t.rooms, p.rooms ?? '—'],
        [t.pricePerM2, fmtMoney(p.pricePerM2Minor, cur)],
        [t.totalPrice, fmtMoney(s.totalMinor, cur)],
        [t.downPayment, fmtMoney(s.downPaymentMinor, cur)],
        [t.paidTotal, fmtMoney(s.paidMinor, cur)],
        [t.remaining, fmtMoney(s.remainingMinor, cur)],
        ...(s.barterCreditedMinor > 0 ? [[t.barter, fmtMoney(s.barterCreditedMinor, cur)]] : []),
        ...(s.nextPayment ? [[t.nextPayment, `${fmtDate(s.nextPayment.date)} · ${fmtMoney(s.nextPayment.amountMinor, cur)}`]] : []),
        [t.manager, contract.manager?.name || '—']
      ]);
      if (contract.schedules?.length && !contract.archived) {
        doc.moveDown(0.8);
        doc.font('Bold').fontSize(11).fillColor('#0f172a').text(t.scheduleTitle);
        doc.moveDown(0.4);
        drawScheduleTable(doc, contract, lang);
      }
    });
    return { buffer, mime: 'application/pdf', filename: `TOZON-contract-${contract.contractNumber || contract.id}.pdf` };
  }

  if (kind === 'SCHEDULE') {
    const buffer = await renderPdfBuffer((doc) => {
      drawHeader(doc, t.scheduleTitle, contract, lang);
      drawKeyValueRows(doc, [
        [t.project, [p.projectName, p.buildingName ? `${t.building} ${p.buildingName}` : null, p.unitNumber ? `№${p.unitNumber}` : null].filter(Boolean).join(' · ')],
        [t.totalPrice, fmtMoney(s.totalMinor, cur)],
        [t.paidTotal, fmtMoney(s.paidMinor, cur)],
        [t.remaining, fmtMoney(s.remainingMinor, cur)]
      ]);
      doc.moveDown(0.6);
      drawScheduleTable(doc, contract, lang);
    });
    return { buffer, mime: 'application/pdf', filename: `TOZON-schedule-${contract.contractNumber || contract.id}.pdf` };
  }

  if (kind === 'RECEIPT') {
    const payment = (contract.history || []).find((row) => row.kind === 'PAYMENT' && String(row.id) === String(paymentId));
    if (!payment) return null;
    const buffer = await renderPdfBuffer((doc) => {
      drawHeader(doc, t.pkoTitle, contract, lang);
      drawKeyValueRows(doc, [
        [t.pkoNo, payment.number || `#${payment.id}`],
        [t.pkoDate, fmtDate(payment.date)],
        [t.pkoStatus, t.payStatuses[payment.status] || payment.status],
        [t.pkoMethod, t.methods[payment.method] || payment.method || t.methods.OTHER],
        [t.pkoAmount, fmtMoney(payment.amountMinor, payment.currency)],
        ...(payment.currency !== cur && payment.creditedMinor !== null
          ? [[t.pkoCredited, fmtMoney(payment.creditedMinor, cur)]]
          : []),
        ...(payment.snapshotTjsMinor !== null && payment.snapshotTjsMinor !== undefined && payment.currency !== 'TJS'
          ? [[t.pkoSnapshotTjs, fmtMoney(payment.snapshotTjsMinor, 'TJS')]]
          : []),
        [t.pkoBasis, payment.purpose || t.pkoBasisDefault],
        [t.project, [p.projectName, p.buildingName ? `${t.building} ${p.buildingName}` : null, p.unitNumber ? `№${p.unitNumber}` : null].filter(Boolean).join(' · ')],
        [t.paidTotal, fmtMoney(s.paidMinor, cur)],
        [t.remaining, fmtMoney(s.remainingMinor, cur)]
      ]);
    });
    return { buffer, mime: 'application/pdf', filename: `TOZON-pko-${payment.id}.pdf` };
  }

  return null;
}
