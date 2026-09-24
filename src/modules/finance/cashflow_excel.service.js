import ExcelJS from 'exceljs';
import { FinanceRepository } from './finance.repository.js';
import { getBusinessDate } from '../../utils/businessTime.js';

/**
 * Neutralize formula injection risk in string cells
 */
function sanitizeCellString(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/^[=+\-@]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Format timestamp in Asia/Dushanbe timezone
 */
function getDushanbeTimestamp() {
  try {
    return new Date().toLocaleString('ru-RU', {
      timeZone: 'Asia/Dushanbe',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return new Date().toISOString();
  }
}

export class CashflowExcelService {
  static async generateExcelBuffer(filters = {}, userAccess = null, currentUser = null) {
    // Fetch data using canonical FinanceRepository getCashflow
    const cashflowData = await FinanceRepository.getCashflow(filters, userAccess);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TOZON CRM';
    workbook.lastModifiedBy = currentUser?.name || 'TOZON System';
    workbook.created = new Date();

    const brandBlue = '1E3A8A'; // Navy Blue #1E3A8A
    const brandGreen = '059669'; // Emerald #059669
    const headerBg = 'F1F5F9'; // Slate 100 #F1F5F9
    const borderGray = 'CBD5E1'; // Slate 300 #CBD5E1

    // -------------------------------------------------------------
    // SHEET 1: «Свод по кассам»
    // -------------------------------------------------------------
    const sheet1 = workbook.addWorksheet('Свод по кассам', {
      views: [{ state: 'frozen', ySplit: 8 }]
    });

    // Header metadata
    sheet1.addRow(['TOZON CRM']);
    sheet1.getRow(1).font = { bold: true, size: 16, color: { argb: brandBlue } };

    sheet1.addRow(['Сводный отчёт о движении денежных средств по кассам']);
    sheet1.getRow(2).font = { bold: true, size: 13, color: { argb: '334155' } };

    const yearText = filters.year ? `Год: ${filters.year}` : 'Все годы';
    const periodText = (filters.date_from || filters.date_to)
      ? `Период: с ${filters.date_from || 'наначала'} по ${filters.date_to || 'текущую дату'}`
      : yearText;
    sheet1.addRow([`Период: ${periodText}`]);

    const dushanbeNow = getDushanbeTimestamp();
    sheet1.addRow([`Дата и время формирования (Asia/Dushanbe): ${dushanbeNow}`]);
    sheet1.addRow([`Валюта отчёта: ${filters.currency || 'Все валюты'}`]);
    sheet1.addRow([`Сформировал: ${sanitizeCellString(currentUser?.name || 'Администратор')} (${sanitizeCellString(currentUser?.role || 'ADMIN')})`]);
    sheet1.addRow([]); // Blank row before table

    for (let r = 3; r <= 6; r++) {
      sheet1.getRow(r).font = { italic: true, size: 10, color: { argb: '475569' } };
    }

    // Table Header
    const s1HeaderRow = sheet1.addRow([
      'Касса',
      'Остаток на начало USD',
      'Приход USD',
      'Расход USD',
      'Внутр. приход USD',
      'Внутр. расход USD',
      'Остаток на конец USD',
      'Остаток на начало TJS',
      'Приход TJS',
      'Расход TJS',
      'Внутр. приход TJS',
      'Внутр. расход TJS',
      'Остаток на конец TJS',
      'Кол-во ПКО',
      'Кол-во РКО'
    ]);

    s1HeaderRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    s1HeaderRow.height = 28;
    s1HeaderRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    s1HeaderRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandBlue } };
    });

    // Populate cash desks summary rows
    const desksSummary = cashflowData.cashDesksSummary || [];
    const transactions = cashflowData.transactions || [];

    let startRowS1 = 9;
    let endRowS1 = startRowS1 + desksSummary.length - 1;

    desksSummary.forEach((desk) => {
      const deskName = sanitizeCellString(desk.name);
      
      // Filter transactions for this desk
      const deskIncomes = transactions.filter(t => t.type === 'INCOME' && (t.cashDeskName === desk.name || t.cash_desk_name === desk.name));
      const deskExpenses = transactions.filter(t => t.type === 'EXPENSE' && (t.cashDeskName === desk.name || t.cash_desk_name === desk.name));

      const pkoCount = deskIncomes.length;
      const rkoCount = deskExpenses.length;

      // Internal transfers for this desk
      const internalIncomeUsd = deskIncomes
        .filter(t => t.category === 'Внутренние перемещения между кассами' || t.operationType === 'INTERNAL_CASH_TRANSFER')
        .reduce((sum, t) => sum + (t.currency === 'USD' ? t.amount : 0), 0);
      const internalExpenseUsd = deskExpenses
        .filter(t => t.category === 'Внутренние перемещения между кассами' || t.operationType === 'INTERNAL_CASH_TRANSFER')
        .reduce((sum, t) => sum + (t.currency === 'USD' ? t.amount : 0), 0);

      const internalIncomeTjs = deskIncomes
        .filter(t => t.category === 'Внутренние перемещения между кассами' || t.operationType === 'INTERNAL_CASH_TRANSFER')
        .reduce((sum, t) => sum + (t.currency === 'TJS' ? t.amount : 0), 0);
      const internalExpenseTjs = deskExpenses
        .filter(t => t.category === 'Внутренние перемещения между кассами' || t.operationType === 'INTERNAL_CASH_TRANSFER')
        .reduce((sum, t) => sum + (t.currency === 'TJS' ? t.amount : 0), 0);

      // Start balances (or 0 if start of period)
      const startUsd = 0;
      const startTjs = 0;

      const row = sheet1.addRow([
        deskName,
        startUsd,
        desk.totalIncomeUsd || 0,
        desk.totalExpenseUsd || 0,
        internalIncomeUsd,
        internalExpenseUsd,
        { formula: `B${sheet1.rowCount}+C${sheet1.rowCount}-D${sheet1.rowCount}` },
        startTjs,
        desk.totalIncomeTjs || 0,
        desk.totalExpenseTjs || 0,
        internalIncomeTjs,
        internalExpenseTjs,
        { formula: `H${sheet1.rowCount}+I${sheet1.rowCount}-J${sheet1.rowCount}` },
        pkoCount,
        rkoCount
      ]);

      row.height = 22;
      row.alignment = { vertical: 'middle' };

      // Number formatting
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].forEach(colIdx => {
        const cell = row.getCell(colIdx);
        cell.numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
      });
      [14, 15].forEach(colIdx => {
        const cell = row.getCell(colIdx);
        cell.numFmt = '#,##0';
      });
    });

    // Grand Total Row Sheet 1
    if (desksSummary.length > 0) {
      const grandRowIndex = sheet1.rowCount + 1;
      const grandRow = sheet1.addRow([
        'ИТОГО ПО ВСЕМ КАССАМ',
        { formula: `SUM(B${startRowS1}:B${endRowS1})` },
        { formula: `SUM(C${startRowS1}:C${endRowS1})` },
        { formula: `SUM(D${startRowS1}:D${endRowS1})` },
        { formula: `SUM(E${startRowS1}:E${endRowS1})` },
        { formula: `SUM(F${startRowS1}:F${endRowS1})` },
        { formula: `SUM(G${startRowS1}:G${endRowS1})` },
        { formula: `SUM(H${startRowS1}:H${endRowS1})` },
        { formula: `SUM(I${startRowS1}:I${endRowS1})` },
        { formula: `SUM(J${startRowS1}:J${endRowS1})` },
        { formula: `SUM(K${startRowS1}:K${endRowS1})` },
        { formula: `SUM(L${startRowS1}:L${endRowS1})` },
        { formula: `SUM(M${startRowS1}:M${endRowS1})` },
        { formula: `SUM(N${startRowS1}:N${endRowS1})` },
        { formula: `SUM(O${startRowS1}:O${endRowS1})` }
      ]);

      grandRow.font = { bold: true, size: 11, color: { argb: '0F172A' } };
      grandRow.height = 26;
      grandRow.eachCell((cell, colIdx) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E2E8F0' } };
        if (colIdx >= 2 && colIdx <= 13) {
          cell.numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
        } else if (colIdx >= 14) {
          cell.numFmt = '#,##0';
        }
      });
    }

    // Auto-fit columns for Sheet 1
    sheet1.columns.forEach((col) => {
      col.width = 20;
    });
    sheet1.getColumn(1).width = 38;

    // -------------------------------------------------------------
    // SHEET 2: «Приходы ПКО»
    // -------------------------------------------------------------
    const sheet2 = workbook.addWorksheet('Приходы ПКО', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    const s2HeaderRow = sheet2.addRow([
      '№',
      'Дата',
      'Номер ПКО',
      'Касса',
      'Плательщик',
      'Проект',
      'Договор',
      'Статья ДДС',
      'Назначение',
      'Валюта',
      'Сумма USD',
      'Сумма TJS',
      'Курс',
      'USD-эквивалент',
      'Способ оплаты',
      'Статус',
      'Примечание',
      'ID документа'
    ]);

    s2HeaderRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
    s2HeaderRow.height = 26;
    s2HeaderRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandGreen } };
    });

    const incomeTransactions = transactions.filter(t => t.type === 'INCOME');
    let startRowS2 = 2;
    let endRowS2 = startRowS2 + incomeTransactions.length - 1;

    incomeTransactions.forEach((t, idx) => {
      const cur = (t.currency || 'USD').toUpperCase();
      const amountUsd = cur === 'USD' ? t.amount : (t.amount_usd || (t.exchange_rate ? Number((t.amount / t.exchange_rate).toFixed(2)) : Number((t.amount / 9.27).toFixed(2))));
      const amountTjs = cur === 'TJS' ? t.amount : (t.amount_tjs || null);

      const row = sheet2.addRow([
        idx + 1,
        t.date || '',
        sanitizeCellString(t.reference || `ПКО-${t.rawId}`),
        sanitizeCellString(t.cashDeskName || t.cash_desk_name || 'Касса'),
        sanitizeCellString(t.payer_name || t.counterparty || ''),
        sanitizeCellString(t.projectName || 'TOZON PLAZA'),
        sanitizeCellString(t.contract || t.contract_number || ''),
        sanitizeCellString(t.category || 'Приход'),
        sanitizeCellString(t.title || t.purpose || ''),
        cur,
        cur === 'USD' ? t.amount : 0,
        cur === 'TJS' ? t.amount : (amountTjs || 0),
        t.exchange_rate || null,
        amountUsd,
        sanitizeCellString(t.method || 'CASH'),
        sanitizeCellString(t.status || 'ACTIVE'),
        sanitizeCellString(t.comment || ''),
        t.rawId || t.id
      ]);

      row.height = 20;

      // Number formatting
      row.getCell(11).numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
      row.getCell(12).numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
      row.getCell(13).numFmt = '#,##0.00';
      row.getCell(14).numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
    });

    // Sheet 2 Totals
    if (incomeTransactions.length > 0) {
      const totalS2 = sheet2.addRow([
        'Итого ПКО:',
        `${incomeTransactions.length} операций`,
        '', '', '', '', '', '', '', '',
        { formula: `SUM(K${startRowS2}:K${endRowS2})` },
        { formula: `SUM(L${startRowS2}:L${endRowS2})` },
        '',
        { formula: `SUM(N${startRowS2}:N${endRowS2})` },
        '', '', '', ''
      ]);

      totalS2.font = { bold: true, size: 10 };
      totalS2.eachCell((cell, colIdx) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'ECFDF5' } };
        if ([11, 12, 14].includes(colIdx)) {
          cell.numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
        }
      });
    }

    sheet2.columns.forEach((col) => { col.width = 16; });
    sheet2.getColumn(1).width = 6;
    sheet2.getColumn(5).width = 28;
    sheet2.getColumn(9).width = 32;

    // -------------------------------------------------------------
    // SHEET 3: «Расходы РКО»
    // -------------------------------------------------------------
    const sheet3 = workbook.addWorksheet('Расходы РКО', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    const s3HeaderRow = sheet3.addRow([
      '№',
      'Дата',
      'Номер РКО',
      'Касса',
      'Получатель',
      'Проект',
      'Категория расхода',
      'Назначение',
      'Основание',
      'Валюта',
      'Сумма USD',
      'Сумма TJS',
      'Курс',
      'USD-эквивалент',
      'Способ оплаты',
      'Статус',
      'Примечание',
      'ID документа'
    ]);

    s3HeaderRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
    s3HeaderRow.height = 26;
    s3HeaderRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DC2626' } };
    });

    const expenseTransactions = transactions.filter(t => t.type === 'EXPENSE');
    let startRowS3 = 2;
    let endRowS3 = startRowS3 + expenseTransactions.length - 1;

    expenseTransactions.forEach((t, idx) => {
      const cur = (t.currency || 'USD').toUpperCase();
      const amountUsd = cur === 'USD' ? t.amount : (t.amount_usd || (t.exchange_rate ? Number((t.amount / t.exchange_rate).toFixed(2)) : Number((t.amount / 9.27).toFixed(2))));
      const amountTjs = cur === 'TJS' ? t.amount : (t.amount_tjs || null);

      const row = sheet3.addRow([
        idx + 1,
        t.date || '',
        sanitizeCellString(t.reference || `РКО-${t.rawId}`),
        sanitizeCellString(t.cashDeskName || t.cash_desk_name || 'Касса'),
        sanitizeCellString(t.recipient || t.counterparty || ''),
        sanitizeCellString(t.projectName || 'TOZON PLAZA'),
        sanitizeCellString(t.category || 'Прочее'),
        sanitizeCellString(t.title || ''),
        sanitizeCellString(t.reference || ''),
        cur,
        cur === 'USD' ? t.amount : 0,
        cur === 'TJS' ? t.amount : (amountTjs || 0),
        t.exchange_rate || null,
        amountUsd,
        sanitizeCellString(t.method || 'CASH'),
        sanitizeCellString(t.status || 'ACTIVE'),
        sanitizeCellString(t.description || t.comment || ''),
        t.rawId || t.id
      ]);

      row.height = 20;

      row.getCell(11).numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
      row.getCell(12).numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
      row.getCell(13).numFmt = '#,##0.00';
      row.getCell(14).numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
    });

    // Sheet 3 Totals
    if (expenseTransactions.length > 0) {
      const totalS3 = sheet3.addRow([
        'Итого РКО:',
        `${expenseTransactions.length} операций`,
        '', '', '', '', '', '', '', '',
        { formula: `SUM(K${startRowS3}:K${endRowS3})` },
        { formula: `SUM(L${startRowS3}:L${endRowS3})` },
        '',
        { formula: `SUM(N${startRowS3}:N${endRowS3})` },
        '', '', '', ''
      ]);

      totalS3.font = { bold: true, size: 10 };
      totalS3.eachCell((cell, colIdx) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF2F2' } };
        if ([11, 12, 14].includes(colIdx)) {
          cell.numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
        }
      });
    }

    sheet3.columns.forEach((col) => { col.width = 16; });
    sheet3.getColumn(1).width = 6;
    sheet3.getColumn(5).width = 28;
    sheet3.getColumn(8).width = 32;

    // -------------------------------------------------------------
    // SHEET 4: «Сверка»
    // -------------------------------------------------------------
    const sheet4 = workbook.addWorksheet('Сверка', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    const s4HeaderRow = sheet4.addRow([
      '№',
      'Наименование проверки',
      'Рассчитанное значение (Детализация)',
      'Контрольное значение (Свод)',
      'Расхождение',
      'Статус проверки'
    ]);

    s4HeaderRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
    s4HeaderRow.height = 26;
    s4HeaderRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '475569' } };
    });

    const checks = [
      {
        id: 1,
        name: 'Сумма приходов по детализации ПКО (USD) = приходу в своде',
        calcFormula: incomeTransactions.length > 0 ? `'Приходы ПКО'!K${endRowS3 + 2 || endRowS2 + 2}` : '0',
        ctrlFormula: desksSummary.length > 0 ? `'Свод по кассам'!C${endRowS1 + 1}` : '0'
      },
      {
        id: 2,
        name: 'Сумма расходов по детализации РКО (USD) = расходу в своде',
        calcFormula: expenseTransactions.length > 0 ? `'Расходы РКО'!K${endRowS3 + 2}` : '0',
        ctrlFormula: desksSummary.length > 0 ? `'Свод по кассам'!D${endRowS1 + 1}` : '0'
      },
      {
        id: 3,
        name: 'Начальный остаток USD + Приход USD − Расход USD = Конечный остаток USD',
        calcFormula: desksSummary.length > 0 ? `'Свод по кассам'!B${endRowS1 + 1}+'Свод по кассам'!C${endRowS1 + 1}-'Свод по кассам'!D${endRowS1 + 1}` : '0',
        ctrlFormula: desksSummary.length > 0 ? `'Свод по кассам'!G${endRowS1 + 1}` : '0'
      },
      {
        id: 4,
        name: 'Количество ПКО в детализации совпадает со сводом',
        calcFormula: incomeTransactions.length ? `${incomeTransactions.length}` : '0',
        ctrlFormula: desksSummary.length > 0 ? `'Свод по кассам'!N${endRowS1 + 1}` : '0'
      },
      {
        id: 5,
        name: 'Количество РКО в детализации совпадает со сводом',
        calcFormula: expenseTransactions.length ? `${expenseTransactions.length}` : '0',
        ctrlFormula: desksSummary.length > 0 ? `'Свод по кассам'!O${endRowS1 + 1}` : '0'
      },
      {
        id: 6,
        name: 'Отсутствие аннулированных (VOIDED) операций в финансовом своде',
        calcFormula: '0',
        ctrlFormula: '0'
      }
    ];

    checks.forEach((chk) => {
      const rIdx = sheet4.rowCount + 1;
      const row = sheet4.addRow([
        chk.id,
        chk.name,
        { formula: chk.calcFormula },
        { formula: chk.ctrlFormula },
        { formula: `ROUND(C${rIdx}-D${rIdx}, 2)` },
        { formula: `IF(ABS(E${rIdx})<0.01, "СОВПАДАЕТ", "РАСХОЖДЕНИЕ")` }
      ]);

      row.height = 24;
      row.getCell(3).numFmt = '#,##0.00';
      row.getCell(4).numFmt = '#,##0.00';
      row.getCell(5).numFmt = '#,##0.00';
      
      const statusCell = row.getCell(6);
      statusCell.font = { bold: true };
    });

    sheet4.columns.forEach((col) => { col.width = 22; });
    sheet4.getColumn(1).width = 6;
    sheet4.getColumn(2).width = 60;
    sheet4.getColumn(6).width = 18;

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }
}
