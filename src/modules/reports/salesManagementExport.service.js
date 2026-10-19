import ExcelJS from 'exceljs';
import { DailyBriefingService } from './dailyBriefing.service.js';
import { WeeklyDynamicsService } from './weeklyDynamics.service.js';
import { BlockPlanFactService } from './blockPlanFact.service.js';
import { getBusinessDate, getBusinessDateTime } from '../../utils/businessTime.js';
import { AppError } from '../../shared/errors/errorHandler.js';

/**
 * Formula injection prevention: neutralizes any potential Excel execution prefix.
 */
export function sanitizeCellString(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Format timestamp in Asia/Dushanbe timezone
 */
export function getDushanbeFormattedTimestamp() {
  try {
    const dt = getBusinessDateTime();
    return `${dt.dateStr} ${dt.timeStr}:00 (Asia/Dushanbe, UTC+5)`;
  } catch {
    return `${getBusinessDate()} (Asia/Dushanbe)`;
  }
}

export class SalesManagementExportService {
  /**
   * Generates a comprehensive multi-sheet Excel (.xlsx) workbook buffer
   * incorporating Daily Briefing, Manager Performance, Blocks Plan-Fact,
   * Weekly Dynamics, Cash Collections, and Operational Raw Registers.
   *
   * @param {Object} query - Filtering parameters (date, weeksCount, period, projectId, buildingId, managerId)
   * @param {Object} user - Authenticated user context
   * @returns {Promise<Buffer>} XLSX binary buffer
   */
  static async generateSalesManagementWorkbook(query = {}, user) {
    if (!user) {
      throw new AppError('Требуется авторизация', 401);
    }

    const allowedRoles = ['ADMIN', 'DIRECTOR', 'SALES_MANAGER'];
    if (!allowedRoles.includes(user.role)) {
      throw new AppError('Доступ к выгрузке аналитики продаж запрещен для вашей роли', 403);
    }

    const isSupervisor = ['ADMIN', 'DIRECTOR'].includes(user.role);

    // Prepare full unpaginated query for export to include all records
    const exportQuery = {
      ...query,
      drilldownLimit: 2000,
      weekDrilldownLimit: 1000,
      blockDrilldownLimit: 1000
    };

    // Normalize block period if query.period is not in YYYY-MM format
    const blockPeriod = (query.period && /^\d{4}-\d{2}$/.test(String(query.period).trim()))
      ? String(query.period).trim()
      : (query.date && /^\d{4}-\d{2}/.test(String(query.date).trim()) ? String(query.date).trim().slice(0, 7) : undefined);

    const exportBlockQuery = {
      ...exportQuery,
      period: blockPeriod
    };

    // Parallel fetch from our verified Phase 3.7.1 services
    const [dailyBriefing, weeklyDynamics, blockPlanFact] = await Promise.all([
      DailyBriefingService.getDailyBriefing(exportQuery, user),
      WeeklyDynamicsService.getWeeklyDynamics(exportQuery, user),
      BlockPlanFactService.getBlockPlanFact(exportBlockQuery, user)
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TOZON CRM';
    workbook.lastModifiedBy = sanitizeCellString(user.name || 'TOZON System');
    workbook.created = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;

    // Palette & Styles - TOZON PLAZA Corporate Dark Green
    const brandDarkGreen = '0F5132'; // Corporate Dark Green #0F5132
    const brandForestGreen = '14532D'; // Deep Forest Green #14532D
    const emeraldGreen = '15803D';   // Emerald Green #15803D (accents)
    const brandNavy = '0F5132';      // Backward-compatible alias
    const brandBlue = '0F5132';      // Green accents #0F5132
    const indigoTjs = '166534';      // TJS Secondary green #166534
    const amberWarn = 'B45309';      // Reservations #B45309
    const roseDanger = 'DC2626';     // Cancelled / Overdue #DC2626
    const totalRowBg = 'D1E7DD';     // Soft Mint-Green Total Background #D1E7DD
    const totalRowFont = '0A3616';   // Dark Forest Green Total Text #0A3616
    const zebraBg = 'F8FAFC';        // Slate 50 zebra
    const borderSlate = 'CBD5E1';    // Slate 300 clean thin border

    const thinBorder = {
      top: { style: 'thin', color: { argb: borderSlate } },
      left: { style: 'thin', color: { argb: borderSlate } },
      bottom: { style: 'thin', color: { argb: borderSlate } },
      right: { style: 'thin', color: { argb: borderSlate } }
    };

    const dushanbeTimestamp = getDushanbeFormattedTimestamp();

    /**
     * Standard corporate header setup for any sheet
     */
    const addSheetHeader = (sheet, title, subtitle = '') => {
      sheet.addRow(['TOZON PLAZA • КОРПОРАТИВНАЯ СИСТЕМА УПРАВЛЕНИЯ ПРОДАЖАМИ']);
      sheet.getRow(1).font = { bold: true, size: 13, color: { argb: brandDarkGreen } };

      sheet.addRow([title]);
      sheet.getRow(2).font = { bold: true, size: 15, color: { argb: '0F172A' } };

      const targetDate = dailyBriefing.date;
      const periodMonth = blockPlanFact.period;
      const weeksCount = weeklyDynamics.periodRange?.weeksCount || 8;

      sheet.addRow([`Период: ${periodMonth} | Дата сводки: ${targetDate} | Горизонт анализа: ${weeksCount} нед.`]);
      sheet.addRow([`Дата и время формирования: ${dushanbeTimestamp}`]);
      sheet.addRow([`Валюта отчета: USD / TJS (раздельный учет) | Сформировал: ${sanitizeCellString(user.name || 'Пользователь')} (${sanitizeCellString(user.role)}) ${subtitle ? `| ${subtitle}` : ''}`]);
      sheet.addRow(['Пояснения: План — утвержденная цель продаж; Факт — только подписанные договоры (SIGNED); Брони — активный пайплайн (RESERVED); Отклонение — разница (Факт - План). Договоры и кассовые поступления учитываются раздельно.']);

      for (let r = 3; r <= 5; r++) {
        sheet.getRow(r).font = { italic: true, size: 9, color: { argb: '475569' } };
      }
      sheet.getRow(6).font = { italic: true, size: 8.5, color: { argb: '64748B' } };
    };

    // =========================================================================
    // ЛИСТ 1: «Сводка» — ежедневные KPI, договоры, брони, поступления
    // =========================================================================
    const sheet1 = workbook.addWorksheet('Сводка', {
      views: [{ state: 'frozen', ySplit: 7 }]
    });
    addSheetHeader(sheet1, 'ЕЖЕДНЕВНАЯ СВОДКА И КЛЮЧЕВЫЕ ПОКАЗАТЕЛИ (KPI)');

    const s1Headers = sheet1.addRow([
      '№',
      'Показатель эффективности / KPI',
      'Значение',
      'Ед. изм.',
      'Категория учета',
      'Примечание / Правило фиксации'
    ]);
    s1Headers.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
    s1Headers.height = 28;
    s1Headers.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    s1Headers.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandDarkGreen } };
      cell.border = thinBorder;
    });

    const sumData = dailyBriefing.summary || {};
    const kpiRows = [
      [1, 'Новые лиды за день', sumData.newLeadsCount || 0, 'лид.', 'Воронка', 'Лиды, поступившие в базу данных за целевую дату'],
      [2, 'Выполненные звонки', sumData.completedCallsCount || 0, 'звон.', 'Активность', 'Звонки менеджеров со статусом COMPLETED'],
      [3, 'Проведенные встречи', sumData.completedMeetingsCount || 0, 'встр.', 'Активность', 'Встречи в офисе продаж со статусом COMPLETED'],
      [4, 'Всего взаимодействий с клиентами', (sumData.completedCallsCount || 0) + (sumData.completedMeetingsCount || 0), 'конт.', 'Активность', 'Сумма результативных звонков и встреч'],
      [5, 'Новые бронирования (RESERVED)', sumData.newReservationsCount || 0, 'кв.', 'Пайплайн', 'Активные бронирования за день (не смешивать с продажами)'],
      [6, 'Объем новых бронирований, USD', sumData.newReservationsVolumeUsd || 0, 'USD', 'Пайплайн', 'Зафиксированная стоимость забронированных квартир'],
      [7, 'Подписанные договоры (SIGNED)', sumData.signedDealsCount || 0, 'дог.', 'Продажи факт', 'Юридически заключенные договоры продажи'],
      [8, 'Объем продаж по договорам, USD', sumData.signedDealsVolumeUsd || 0, 'USD', 'Продажи факт', 'Сумма подписанных контрактов продажи'],
      [9, 'Реализованная площадь, м²', sumData.signedAreaM2 || 0, 'м²', 'Продажи факт', 'Суммарная площадь квартир по подписанным договорам'],
      [10, 'Фактические поступления USD (Cash-in)', sumData.collectedCashUsd || 0, 'USD', 'Финансы факт', 'Реально поступившие денежные средства в кассу в USD'],
      [11, 'Фактические поступления TJS (Cash-in)', sumData.collectedCashTjs || 0, 'TJS', 'Финансы факт', 'Реально поступившие денежные средства в кассу в TJS'],
      [12, 'Просроченные задачи менеджеров', sumData.overdueTasksCount || 0, 'задач', 'Контроль SLA', 'Открытые задачи со сроком исполнения ранее отчетной даты'],
      [13, 'Расторгнутые / отмененные сделки', sumData.cancelledDealsCount || 0, 'сдел.', 'Отток', 'Сделки в статусе CANCELLED (исключены из факта продаж)'],
      [14, 'Объем расторгнутых сделок, USD', Number(((sumData.cancelledDealsVolumeMinor || 0) / 100).toFixed(2)), 'USD', 'Отток', 'Сумма расторгнутых сделок за дату']
    ];

    kpiRows.forEach((rowValues, idx) => {
      const row = sheet1.addRow(rowValues);
      row.height = 22;
      row.alignment = { vertical: 'middle' };
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(3).alignment = { horizontal: 'right' };
      row.getCell(4).alignment = { horizontal: 'center' };

      // Number formatting
      if ([6, 8, 10, 14].includes(rowValues[0])) {
        row.getCell(3).numFmt = '#,##0.00';
      } else if ([11].includes(rowValues[0])) {
        row.getCell(3).numFmt = '#,##0.00';
      } else if ([9].includes(rowValues[0])) {
        row.getCell(3).numFmt = '#,##0.00';
      } else {
        row.getCell(3).numFmt = '#,##0';
      }

      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
        });
      }
      row.eachCell(cell => { cell.border = thinBorder; });
    });

    sheet1.getColumn(1).width = 6;
    sheet1.getColumn(2).width = 44;
    sheet1.getColumn(3).width = 22;
    sheet1.getColumn(4).width = 12;
    sheet1.getColumn(5).width = 18;
    sheet1.getColumn(6).width = 48;
    sheet1.autoFilter = { from: 'A7', to: `F${sheet1.rowCount}` };
    sheet1.pageSetup = {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '7:7',
      printArea: `A1:F${sheet1.rowCount}`
    };


    // =========================================================================
    // ЛИСТ 2: «Менеджеры» — результаты работы каждого менеджера
    // =========================================================================
    const sheet2 = workbook.addWorksheet('Менеджеры', {
      views: [{ state: 'frozen', ySplit: 7 }]
    });
    addSheetHeader(sheet2, 'РЕЗУЛЬТАТЫ РАБОТЫ И KPI ОТДЕЛА ПРОДАЖ ПО МЕНЕДЖЕРАМ');

    const s2Headers = sheet2.addRow([
      '№',
      'Менеджер отдела продаж',
      'Должность / Роль',
      'Новые лиды, шт',
      'Звонки (факт), шт',
      'Встречи (факт), шт',
      'Всего контактов, шт',
      'Брони (пайплайн), шт',
      'Сумма броней, USD',
      'Подписано договоров, шт',
      'Сумма продаж, USD',
      'Поступления кассы, USD ($)',
      'Поступления кассы, TJS (смн)',
      'Просрочено задач, шт'
    ]);
    s2Headers.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
    s2Headers.height = 28;
    s2Headers.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    s2Headers.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandDarkGreen } };
      cell.border = thinBorder;
    });

    const managersList = dailyBriefing.managerDailyBreakdown || [];
    const filteredManagers = isSupervisor ? managersList : managersList.filter(m => Number(m.managerId) === Number(user.id));
    const s2StartRow = 8;

    filteredManagers.forEach((m, idx) => {
      const row = sheet2.addRow([
        idx + 1,
        sanitizeCellString(m.name),
        sanitizeCellString(m.role),
        m.newLeadsCount || 0,
        m.completedCallsCount || 0,
        m.completedMeetingsCount || 0,
        { formula: `E${sheet2.rowCount + 1}+F${sheet2.rowCount + 1}`, result: (m.completedCallsCount || 0) + (m.completedMeetingsCount || 0) },
        m.newReservationsCount || 0,
        m.newReservationsVolumeUsd || 0,
        m.signedDealsCount || 0,
        m.signedDealsVolumeUsd || 0,
        m.collectedCashUsd || 0,
        m.collectedCashTjs || 0,
        m.overdueTasksCount || 0
      ]);

      row.height = 22;
      row.alignment = { vertical: 'middle' };
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(3).alignment = { horizontal: 'center' };

      // Formatting
      [4, 5, 6, 7, 8, 10, 14].forEach(c => {
        row.getCell(c).alignment = { horizontal: 'right' };
        row.getCell(c).numFmt = '#,##0';
      });
      [9, 11, 12, 13].forEach(c => {
        row.getCell(c).alignment = { horizontal: 'right' };
        row.getCell(c).numFmt = '#,##0.00';
      });

      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
        });
      }
      row.eachCell(cell => { cell.border = thinBorder; });
    });

    const s2EndRow = sheet2.rowCount;
    if (filteredManagers.length > 0) {
      const totalRow = sheet2.addRow([
        '',
        'ИТОГО ПО ОТДЕЛУ ПРОДАЖ',
        `${filteredManagers.length} сотр.`,
        { formula: `SUM(D${s2StartRow}:D${s2EndRow})` },
        { formula: `SUM(E${s2StartRow}:E${s2EndRow})` },
        { formula: `SUM(F${s2StartRow}:F${s2EndRow})` },
        { formula: `SUM(G${s2StartRow}:G${s2EndRow})` },
        { formula: `SUM(H${s2StartRow}:H${s2EndRow})` },
        { formula: `SUM(I${s2StartRow}:I${s2EndRow})` },
        { formula: `SUM(J${s2StartRow}:J${s2EndRow})` },
        { formula: `SUM(K${s2StartRow}:K${s2EndRow})` },
        { formula: `SUM(L${s2StartRow}:L${s2EndRow})` },
        { formula: `SUM(M${s2StartRow}:M${s2EndRow})` },
        { formula: `SUM(N${s2StartRow}:N${s2EndRow})` }
      ]);

      totalRow.font = { bold: true, size: 10, color: { argb: totalRowFont } };
      totalRow.height = 26;
      totalRow.alignment = { vertical: 'middle' };
      totalRow.eachCell((cell, colIdx) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: totalRowBg } };
        cell.border = thinBorder;
        if ([4, 5, 6, 7, 8, 10, 14].includes(colIdx)) {
          cell.numFmt = '#,##0';
          cell.alignment = { horizontal: 'right' };
        } else if ([9, 11, 12, 13].includes(colIdx)) {
          cell.numFmt = '#,##0.00';
          cell.alignment = { horizontal: 'right' };
        }
      });
    }

    sheet2.columns.forEach((col, idx) => {
      if (idx === 0) col.width = 6;
      else if (idx === 1) col.width = 28;
      else if (idx === 2) col.width = 18;
      else if ([8, 10, 11, 12].includes(idx)) col.width = 18;
      else col.width = 15;
    });
    sheet2.autoFilter = { from: 'A7', to: `N${s2EndRow}` };
    sheet2.pageSetup = {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '7:7',
      printArea: `A1:N${sheet2.rowCount}`
    };


    // =========================================================================
    // Helper for Blocks sheets (Лист 3: «Блок А», Лист 4: «Блок Б»)
    // =========================================================================
    const renderBlockSheet = (sheetName, targetCode, fallbackName) => {
      const sheet = workbook.addWorksheet(sheetName, {
        views: [{ state: 'frozen', ySplit: 14 }]
      });

      const blockInfo = (blockPlanFact.blocks || []).find(b => {
        const code = (b.buildingCode || '').toUpperCase();
        const name = (b.buildingName || '').toUpperCase();
        if (targetCode === 'A' || targetCode === 'А') {
          return code === 'A' || code === 'БЛОК-А' || name.endsWith('А') || name.includes('БЛОК А');
        }
        if (targetCode === 'B' || targetCode === 'Б') {
          return code === 'B' || code === 'БЛОК-Б' || name.endsWith('Б') || name.includes('БЛОК Б');
        }
        return code === targetCode || name.includes(fallbackName);
      }) || {
        buildingName: `${fallbackName}`,
        buildingCode: targetCode,
        plan: { targetDealsCount: 0, targetVolumeUsd: 0 },
        fact: { signedDealsCount: 0, signedVolumeUsd: 0, signedAreaM2: 0, averagePricePerM2Usd: 0 },
        execution: { dealsPercent: 0, volumePercent: 0, dealsGap: 0, volumeGapUsd: 0 },
        pipelineReserved: { reservedDealsCount: 0, reservedVolumeUsd: 0, reservedAreaM2: 0 },
        cancelled: { cancelledDealsCount: 0, cancelledVolumeUsd: 0 },
        drilldowns: { signedDeals: [], reservedDeals: [], cancelledDeals: [] }
      };

      addSheetHeader(sheet, `ПЛАН-ФАКТ И ДЕТАЛИЗАЦИЯ ПРОДАЖ: ${blockInfo.buildingName.toUpperCase()}`, `ЖК: ${blockInfo.projectName || 'Somon Residence'}`);

      // Plan-Fact KPI summary block (Rows 7-12)
      sheet.addRow(['ПОКАЗАТЕЛЬ ПЛАН-ФАКТА', 'ПЛАН', 'ФАКТ / ВЫПОЛНЕНО', 'ОТКЛОНЕНИЕ (GAP)', '% ВЫПОЛНЕНИЯ', 'СТАТУС И ПАЙПЛАЙН']);
      sheet.getRow(7).font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
      sheet.getRow(7).height = 28;
      sheet.getRow(7).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      sheet.getRow(7).eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandDarkGreen } };
        cell.border = thinBorder;
      });

      const hasPlanDeals = (blockInfo.plan?.targetDealsCount || 0) > 0;
      const hasPlanVolume = (blockInfo.plan?.targetVolumeUsd || 0) > 0;
      const dealsGap = (blockInfo.fact?.signedDealsCount || 0) - (blockInfo.plan?.targetDealsCount || 0);
      const volumeGap = Number(((blockInfo.fact?.signedVolumeUsd || 0) - (blockInfo.plan?.targetVolumeUsd || 0)).toFixed(2));

      const r8 = sheet.addRow([
        'Количество договоров продажи, шт.',
        blockInfo.plan?.targetDealsCount || 0,
        blockInfo.fact?.signedDealsCount || 0,
        dealsGap,
        hasPlanDeals ? `${blockInfo.execution?.dealsPercent || 0}%` : 'Нет плана',
        `В брони: ${blockInfo.pipelineReserved?.reservedDealsCount || 0} кв.`
      ]);
      const r9 = sheet.addRow([
        'Объем продаж по договорам, USD',
        blockInfo.plan?.targetVolumeUsd || 0,
        blockInfo.fact?.signedVolumeUsd || 0,
        volumeGap,
        hasPlanVolume ? `${blockInfo.execution?.volumePercent || 0}%` : 'Нет плана',
        `Брони: $${(blockInfo.pipelineReserved?.reservedVolumeUsd || 0).toLocaleString('ru-RU')}`
      ]);
      const r10 = sheet.addRow([
        'Проданная площадь, м²',
        '—',
        blockInfo.fact?.signedAreaM2 || 0,
        '—',
        '—',
        `Площадь в брони: ${blockInfo.pipelineReserved?.reservedAreaM2 || 0} м²`
      ]);
      const r11 = sheet.addRow([
        'Средняя цена за м², USD',
        '—',
        blockInfo.fact?.averagePricePerM2Usd || 0,
        '—',
        '—',
        `Отменено сделок: ${blockInfo.cancelled?.cancelledDealsCount || 0} ($${(blockInfo.cancelled?.cancelledVolumeUsd || 0).toLocaleString('ru-RU')})`
      ]);
      sheet.addRow([]); // Blank row 12
      sheet.addRow(['РЕЕСТР ПОДПИСАННЫХ ДОГОВОРОВ ПРОДАЖИ (ФАКТ)']); // Row 13
      sheet.getRow(13).font = { bold: true, size: 11, color: { argb: brandDarkGreen } };

      [r8, r9, r10, r11].forEach(r => {
        r.height = 20;
        r.alignment = { vertical: 'middle' };
        r.getCell(1).font = { bold: true };
        r.eachCell(cell => { cell.border = thinBorder; });
      });
      r8.getCell(2).numFmt = '#,##0';
      r8.getCell(3).numFmt = '#,##0';
      r8.getCell(4).numFmt = '#,##0';
      r9.getCell(2).numFmt = '#,##0.00';
      r9.getCell(3).numFmt = '#,##0.00';
      r9.getCell(4).numFmt = '#,##0.00';
      r10.getCell(3).numFmt = '#,##0.00';
      r11.getCell(3).numFmt = '#,##0.00';

      // Table 1: Detailed Signed Deals (Row 14)
      const signedHeaders = sheet.addRow([
        '№',
        'Номер договора',
        'Квартира',
        'Комнат',
        'Площадь, м²',
        'Стоимость договора, USD',
        'Покупатель / Клиент',
        'Телефон',
        'Ответственный менеджер',
        'Дата подписания договора'
      ]);
      signedHeaders.font = { bold: true, color: { argb: 'FFFFFF' }, size: 9 };
      signedHeaders.height = 28;
      signedHeaders.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      signedHeaders.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandDarkGreen } };
        cell.border = thinBorder;
      });

      const signedList = blockInfo.drilldowns?.signedDeals || [];
      const signedStartRow = sheet.rowCount + 1;

      signedList.forEach((d, idx) => {
        const row = sheet.addRow([
          idx + 1,
          sanitizeCellString(d.contractNumber),
          sanitizeCellString(d.unitNumber ? `№${d.unitNumber}` : '—'),
          d.rooms || '—',
          d.areaM2 || 0,
          d.finalPriceUsd || 0,
          sanitizeCellString(d.clientName),
          sanitizeCellString(isSupervisor ? (d.phone || '') : (Number(d.managerId) === Number(user.id) ? (d.phone || '') : '***')),
          sanitizeCellString(d.managerName),
          d.signedAt ? String(d.signedAt).slice(0, 10) : '—'
        ]);

        row.height = 20;
        row.alignment = { vertical: 'middle' };
        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(4).alignment = { horizontal: 'center' };
        row.getCell(5).alignment = { horizontal: 'right' };
        row.getCell(6).alignment = { horizontal: 'right' };
        row.getCell(10).alignment = { horizontal: 'center' };

        row.getCell(5).numFmt = '#,##0.00';
        row.getCell(6).numFmt = '#,##0.00';

        if (idx % 2 === 1) {
          row.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
          });
        }
        row.eachCell(cell => { cell.border = thinBorder; });
      });

      const signedEndRow = sheet.rowCount;
      if (signedList.length > 0) {
        const totalSigned = sheet.addRow([
          '',
          'ИТОГО ПОДПИСАНО',
          `${signedList.length} кв.`,
          '',
          { formula: `SUM(E${signedStartRow}:E${signedEndRow})` },
          { formula: `SUM(F${signedStartRow}:F${signedEndRow})` },
          '',
          '',
          '',
          ''
        ]);
        totalSigned.font = { bold: true, size: 10, color: { argb: totalRowFont } };
        totalSigned.height = 25;
        totalSigned.alignment = { vertical: 'middle' };
        totalSigned.getCell(5).alignment = { horizontal: 'right' };
        totalSigned.getCell(6).alignment = { horizontal: 'right' };
        totalSigned.getCell(5).numFmt = '#,##0.00';
        totalSigned.getCell(6).numFmt = '#,##0.00';
        totalSigned.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: totalRowBg } };
          cell.border = thinBorder;
        });
      }

      // Space before Table 2
      sheet.addRow([]);
      sheet.addRow(['РЕЕСТР АКТИВНЫХ БРОНИРОВАНИЙ (ПАЙПЛАЙН)']);
      sheet.getRow(sheet.rowCount).font = { bold: true, size: 11, color: { argb: brandForestGreen } };

      const resHeaders = sheet.addRow([
        '№',
        'Номер брони / договора',
        'Квартира',
        'Площадь, м²',
        'Стоимость бронирования, USD',
        'Клиент',
        'Менеджер',
        'Срок бронирования'
      ]);
      resHeaders.font = { bold: true, color: { argb: 'FFFFFF' }, size: 9 };
      resHeaders.height = 28;
      resHeaders.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      resHeaders.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandForestGreen } };
        cell.border = thinBorder;
      });

      const resList = blockInfo.drilldowns?.reservedDeals || [];
      const resStartRow = sheet.rowCount + 1;

      resList.forEach((r, idx) => {
        const row = sheet.addRow([
          idx + 1,
          sanitizeCellString(r.contractNumber || `Бронь #${r.id}`),
          sanitizeCellString(r.unitNumber ? `№${r.unitNumber}` : '—'),
          r.areaM2 || 0,
          r.finalPriceUsd || 0,
          sanitizeCellString(r.clientName),
          sanitizeCellString(r.managerName),
          r.reservationExpiresAt ? String(r.reservationExpiresAt).slice(0, 10) : '—'
        ]);

        row.height = 20;
        row.alignment = { vertical: 'middle' };
        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(4).alignment = { horizontal: 'right' };
        row.getCell(5).alignment = { horizontal: 'right' };
        row.getCell(8).alignment = { horizontal: 'center' };

        row.getCell(4).numFmt = '#,##0.00';
        row.getCell(5).numFmt = '#,##0.00';

        if (idx % 2 === 1) {
          row.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
          });
        }
        row.eachCell(cell => { cell.border = thinBorder; });
      });

      const resEndRow = sheet.rowCount;
      if (resList.length > 0) {
        const totalRes = sheet.addRow([
          '',
          'ИТОГО В БРОНИ',
          `${resList.length} кв.`,
          { formula: `SUM(D${resStartRow}:D${resEndRow})` },
          { formula: `SUM(E${resStartRow}:E${resEndRow})` },
          '',
          '',
          ''
        ]);
        totalRes.font = { bold: true, size: 10, color: { argb: totalRowFont } };
        totalRes.height = 25;
        totalRes.alignment = { vertical: 'middle' };
        totalRes.getCell(4).alignment = { horizontal: 'right' };
        totalRes.getCell(5).alignment = { horizontal: 'right' };
        totalRes.getCell(4).numFmt = '#,##0.00';
        totalRes.getCell(5).numFmt = '#,##0.00';
        totalRes.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: totalRowBg } };
          cell.border = thinBorder;
        });
      }

      sheet.getColumn(1).width = 6;
      sheet.getColumn(2).width = 24;
      sheet.getColumn(3).width = 14;
      sheet.getColumn(4).width = 12;
      sheet.getColumn(5).width = 16;
      sheet.getColumn(6).width = 22;
      sheet.getColumn(7).width = 28;
      sheet.getColumn(8).width = 18;
      sheet.getColumn(9).width = 24;
      sheet.getColumn(10).width = 16;
      sheet.autoFilter = { from: 'A14', to: `J${signedEndRow}` };
      sheet.pageSetup = {
        orientation: 'landscape',
        paperSize: 9,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: '14:14',
        printArea: `A1:J${sheet.rowCount}`
      };
    };

    // Render Sheet 3: «Блок А» and Sheet 4: «Блок Б»
    renderBlockSheet('Блок А', 'A', 'Блок А');
    renderBlockSheet('Блок Б', 'B', 'Блок Б');


    // =========================================================================
    // ЛИСТ 5: «Недельная динамика» — результаты по календарным неделям
    // =========================================================================
    const sheet5 = workbook.addWorksheet('Недельная динамика', {
      views: [{ state: 'frozen', ySplit: 7 }]
    });
    addSheetHeader(sheet5, 'ПОНЕДЕЛЬНАЯ ДИНАМИКА И ТЕМП ПРОДАЖ (ПО КАЛЕНДАРНЫМ НЕДЕЛЯМ)');

    const s5Headers = sheet5.addRow([
      '№ Недели',
      'Начало периода',
      'Конец периода',
      'Новые лиды, шт',
      'Брони (пайплайн), шт',
      'Объем броней, USD',
      'Подписано договоров, шт',
      'Проданная площадь, м²',
      'Выручка по договорам, USD',
      'Поступления кассы, USD ($)',
      'Поступления кассы, TJS (смн)',
      'Конверсия лид → договор, %',
      'Расторгнуто сделок, шт'
    ]);
    s5Headers.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
    s5Headers.height = 28;
    s5Headers.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    s5Headers.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandDarkGreen } };
      cell.border = thinBorder;
    });

    const weeksData = weeklyDynamics.weeks || [];
    const s5StartRow = 8;

    weeksData.forEach((w, idx) => {
      const row = sheet5.addRow([
        w.weekNumber ? `Неделя ${w.weekNumber}` : `Неделя ${idx + 1}`,
        w.startDate,
        w.endDate,
        w.leadsCount || 0,
        w.reservationsCount || 0,
        w.reservationsVolumeUsd || 0,
        w.signedDealsCount || 0,
        w.signedAreaM2 || 0,
        w.signedDealsVolumeUsd || 0,
        w.paymentsVolumeUsd || 0,
        w.paymentsVolumeTjs || 0,
        w.leadsCount > 0 ? { formula: `G${sheet5.rowCount + 1}/D${sheet5.rowCount + 1}`, result: ((w.signedDealsCount || 0) / w.leadsCount) } : 0,
        w.cancelledDealsCount || 0
      ]);

      row.height = 22;
      row.alignment = { vertical: 'middle' };
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(3).alignment = { horizontal: 'center' };

      // Number formatting
      [4, 5, 7, 13].forEach(c => {
        row.getCell(c).alignment = { horizontal: 'right' };
        row.getCell(c).numFmt = '#,##0';
      });
      [6, 8, 9, 10, 11].forEach(c => {
        row.getCell(c).alignment = { horizontal: 'right' };
        row.getCell(c).numFmt = '#,##0.00';
      });
      row.getCell(12).alignment = { horizontal: 'right' };
      row.getCell(12).numFmt = '0.0%';

      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
        });
      }
      row.eachCell(cell => { cell.border = thinBorder; });
    });

    const s5EndRow = sheet5.rowCount;
    if (weeksData.length > 0) {
      const totalWeekRow = sheet5.addRow([
        'ИТОГО ЗА ГОРИЗОНТ',
        weeksData[0]?.startDate || '',
        weeksData[weeksData.length - 1]?.endDate || '',
        { formula: `SUM(D${s5StartRow}:D${s5EndRow})` },
        { formula: `SUM(E${s5StartRow}:E${s5EndRow})` },
        { formula: `SUM(F${s5StartRow}:F${s5EndRow})` },
        { formula: `SUM(G${s5StartRow}:G${s5EndRow})` },
        { formula: `SUM(H${s5StartRow}:H${s5EndRow})` },
        { formula: `SUM(I${s5StartRow}:I${s5EndRow})` },
        { formula: `SUM(J${s5StartRow}:J${s5EndRow})` },
        { formula: `SUM(K${s5StartRow}:K${s5EndRow})` },
        { formula: `IF(D${s5EndRow + 1}>0, G${s5EndRow + 1}/D${s5EndRow + 1}, 0)` },
        { formula: `SUM(M${s5StartRow}:M${s5EndRow})` }
      ]);

      totalWeekRow.font = { bold: true, size: 10, color: { argb: totalRowFont } };
      totalWeekRow.height = 26;
      totalWeekRow.alignment = { vertical: 'middle' };
      totalWeekRow.eachCell((cell, colIdx) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: totalRowBg } };
        cell.border = thinBorder;
        if ([4, 5, 7, 13].includes(colIdx)) {
          cell.numFmt = '#,##0';
          cell.alignment = { horizontal: 'right' };
        } else if ([6, 8, 9, 10, 11].includes(colIdx)) {
          cell.numFmt = '#,##0.00';
          cell.alignment = { horizontal: 'right' };
        } else if (colIdx === 12) {
          cell.numFmt = '0.0%';
          cell.alignment = { horizontal: 'right' };
        }
      });
    }

    sheet5.columns.forEach((col, idx) => {
      if (idx === 0) col.width = 14;
      else if (idx === 1 || idx === 2) col.width = 15;
      else if ([5, 7, 8, 9, 10].includes(idx)) col.width = 18;
      else col.width = 15;
    });
    sheet5.autoFilter = { from: 'A7', to: `M${s5EndRow}` };
    sheet5.pageSetup = {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '7:7',
      printArea: `A1:M${sheet5.rowCount}`
    };


    // =========================================================================
    // ЛИСТ 6: «Поступления» — фактические платежи с отдельными колонками USD и TJS
    // =========================================================================
    const sheet6 = workbook.addWorksheet('Поступления', {
      views: [{ state: 'frozen', ySplit: 7 }]
    });
    addSheetHeader(sheet6, 'РЕЕСТР ФАКТИЧЕСКИХ КАССОВЫХ ПОСТУПЛЕНИЙ (CASH-IN)');

    const s6Headers = sheet6.addRow([
      '№ п/п',
      'Номер ПКО (ID)',
      'Номер договора',
      'Квартира',
      'Дата поступления',
      'Плательщик / Покупатель',
      'Телефон',
      'Сумма поступило, USD ($)',
      'Сумма поступило, TJS (смн)',
      'Форма оплаты',
      'Ответственный менеджер',
      'Основание платежа / Примечание'
    ]);
    s6Headers.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
    s6Headers.height = 28;
    s6Headers.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    s6Headers.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandDarkGreen } };
      cell.border = thinBorder;
    });

    const rawPayments = dailyBriefing.drilldowns?.postedPayments || [];
    const s6StartRow = 8;

    rawPayments.forEach((p, idx) => {
      const isUsd = p.currency === 'USD';
      const isTjs = p.currency === 'TJS';
      const amount = p.amountFormatted || Number(((p.amountMinor || 0) / 100).toFixed(2));

      const row = sheet6.addRow([
        idx + 1,
        sanitizeCellString(`ПКО #${p.id}`),
        sanitizeCellString(p.contractNumber || '—'),
        sanitizeCellString(p.unitNumber ? `№${p.unitNumber}` : '—'),
        p.paymentDate || '—',
        sanitizeCellString(p.clientName || 'Плательщик'),
        sanitizeCellString(isSupervisor ? (p.phone || '') : (Number(p.managerId) === Number(user.id) ? (p.phone || '') : '***')),
        isUsd ? amount : 0,
        isTjs ? amount : 0,
        sanitizeCellString(p.method || 'CASH'),
        sanitizeCellString(p.managerName || 'Не назначен'),
        sanitizeCellString(p.reference || p.comment || 'Оплата по договору')
      ]);

      row.height = 22;
      row.alignment = { vertical: 'middle' };
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(3).alignment = { horizontal: 'center' };
      row.getCell(4).alignment = { horizontal: 'center' };
      row.getCell(5).alignment = { horizontal: 'center' };
      row.getCell(8).alignment = { horizontal: 'right' };
      row.getCell(9).alignment = { horizontal: 'right' };
      row.getCell(10).alignment = { horizontal: 'center' };

      row.getCell(8).numFmt = '#,##0.00;[Red]-#,##0.00;\"-\"';
      row.getCell(9).numFmt = '#,##0.00;[Red]-#,##0.00;\"-\"';

      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
        });
      }
      row.eachCell(cell => { cell.border = thinBorder; });
    });

    const s6EndRow = sheet6.rowCount;
    if (rawPayments.length > 0) {
      const totalPaymentsRow = sheet6.addRow([
        'ИТОГО',
        'ПОСТУПИЛО',
        `${rawPayments.length} платежей`,
        '',
        '',
        '',
        '',
        { formula: `SUM(H${s6StartRow}:H${s6EndRow})` },
        { formula: `SUM(I${s6StartRow}:I${s6EndRow})` },
        '',
        '',
        ''
      ]);

      totalPaymentsRow.font = { bold: true, size: 10, color: { argb: totalRowFont } };
      totalPaymentsRow.height = 26;
      totalPaymentsRow.alignment = { vertical: 'middle' };
      totalPaymentsRow.getCell(8).alignment = { horizontal: 'right' };
      totalPaymentsRow.getCell(9).alignment = { horizontal: 'right' };
      totalPaymentsRow.getCell(8).numFmt = '#,##0.00';
      totalPaymentsRow.getCell(9).numFmt = '#,##0.00';

      totalPaymentsRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: totalRowBg } };
        cell.border = thinBorder;
      });
    }

    sheet6.getColumn(1).width = 6;
    sheet6.getColumn(2).width = 16;
    sheet6.getColumn(3).width = 18;
    sheet6.getColumn(4).width = 14;
    sheet6.getColumn(5).width = 16;
    sheet6.getColumn(6).width = 28;
    sheet6.getColumn(7).width = 18;
    sheet6.getColumn(8).width = 22;
    sheet6.getColumn(9).width = 22;
    sheet6.getColumn(10).width = 16;
    sheet6.getColumn(11).width = 24;
    sheet6.getColumn(12).width = 34;
    sheet6.autoFilter = { from: 'A7', to: `L${s6EndRow}` };
    sheet6.pageSetup = {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '7:7',
      printArea: `A1:L${sheet6.rowCount}`
    };


    // =========================================================================
    // ЛИСТ 7: «Исходные данные» — реестры лидов, звонков и просроченных задач
    // =========================================================================
    const sheet7 = workbook.addWorksheet('Исходные данные', {
      views: [{ state: 'frozen', ySplit: 8 }]
    });
    addSheetHeader(sheet7, 'РЕЕСТРЫ ОПЕРАТИВНОЙ ДЕТАЛИЗАЦИИ (ЛИДЫ, АКТИВНОСТИ, ЗАДАЧИ)');

    // Section 1: Новые лиды за день
    sheet7.addRow(['1. РЕЕСТР НОВЫХ ЛИДОВ ЗА ОТЧЕТНУЮ ДАТУ']);
    sheet7.getRow(7).font = { bold: true, size: 11, color: { argb: brandDarkGreen } };

    const leadsHeaders = sheet7.addRow([
      '№',
      'ID Лида',
      'ФИО Клиента',
      'Телефон',
      'Источник',
      'Текущий статус',
      'Ответственный менеджер',
      'Дата и время создания'
    ]);
    leadsHeaders.font = { bold: true, color: { argb: 'FFFFFF' }, size: 9 };
    leadsHeaders.height = 28;
    leadsHeaders.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    leadsHeaders.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandDarkGreen } };
      cell.border = thinBorder;
    });

    const leadsList = dailyBriefing.drilldowns?.newLeads || [];
    leadsList.forEach((l, idx) => {
      const row = sheet7.addRow([
        idx + 1,
        sanitizeCellString(`Лид #${l.id}`),
        sanitizeCellString(l.fullName),
        sanitizeCellString(isSupervisor ? (l.phone || '') : (Number(l.managerId) === Number(user.id) ? (l.phone || '') : '***')),
        sanitizeCellString(l.source || 'Прямой'),
        sanitizeCellString(l.status || 'NEW'),
        sanitizeCellString(l.managerName || 'Не назначен'),
        l.createdAt ? String(l.createdAt).replace('T', ' ').slice(0, 19) : '—'
      ]);

      row.height = 20;
      row.alignment = { vertical: 'middle' };
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(6).alignment = { horizontal: 'center' };
      row.getCell(8).alignment = { horizontal: 'center' };

      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
        });
      }
      row.eachCell(cell => { cell.border = thinBorder; });
    });

    // Space before Section 2
    sheet7.addRow([]);
    sheet7.addRow(['2. РЕЕСТР ВЫПОЛНЕННЫХ ЗВОНКОВ И ВСТРЕЧ']);
    sheet7.getRow(sheet7.rowCount).font = { bold: true, size: 11, color: { argb: brandForestGreen } };

    const interactionsHeaders = sheet7.addRow([
      '№',
      'ID Задачи',
      'Тип действия',
      'Клиент',
      'Телефон',
      'Название / Задача',
      'Ответственный менеджер',
      'Дата выполнения'
    ]);
    interactionsHeaders.font = { bold: true, color: { argb: 'FFFFFF' }, size: 9 };
    interactionsHeaders.height = 28;
    interactionsHeaders.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    interactionsHeaders.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandForestGreen } };
      cell.border = thinBorder;
    });

    const callsList = dailyBriefing.drilldowns?.completedCalls || [];
    const meetingsList = dailyBriefing.drilldowns?.completedMeetings || [];
    const interactions = [...callsList, ...meetingsList];

    interactions.forEach((item, idx) => {
      const row = sheet7.addRow([
        idx + 1,
        sanitizeCellString(`Task #${item.id}`),
        sanitizeCellString(item.type === 'MEETING' ? 'ВСТРЕЧА В ОФИСЕ' : 'ЗВОНОК КЛИЕНТУ'),
        sanitizeCellString(item.clientName || 'Клиент'),
        sanitizeCellString(isSupervisor ? (item.phone || '') : (Number(item.managerId) === Number(user.id) ? (item.phone || '') : '***')),
        sanitizeCellString(item.title || 'Взаимодействие'),
        sanitizeCellString(item.managerName || 'Менеджер'),
        item.completedAt ? String(item.completedAt).slice(0, 10) : '—'
      ]);

      row.height = 20;
      row.alignment = { vertical: 'middle' };
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(3).alignment = { horizontal: 'center' };
      row.getCell(8).alignment = { horizontal: 'center' };

      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
        });
      }
      row.eachCell(cell => { cell.border = thinBorder; });
    });

    // Space before Section 3
    sheet7.addRow([]);
    sheet7.addRow(['3. РЕЕСТР ПРОСРОЧЕННЫХ ЗАДАЧ МЕНЕДЖЕРОВ']);
    sheet7.getRow(sheet7.rowCount).font = { bold: true, size: 11, color: { argb: roseDanger } };

    const tasksHeaders = sheet7.addRow([
      '№',
      'ID Задачи',
      'Тип задачи',
      'Название задачи',
      'Клиент',
      'Телефон',
      'Ответственный менеджер',
      'Срок исполнения',
      'Приоритет'
    ]);
    tasksHeaders.font = { bold: true, color: { argb: 'FFFFFF' }, size: 9 };
    tasksHeaders.height = 28;
    tasksHeaders.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    tasksHeaders.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: roseDanger } };
      cell.border = thinBorder;
    });

    const overdueTasks = dailyBriefing.drilldowns?.overdueTasks || [];
    overdueTasks.forEach((t, idx) => {
      const row = sheet7.addRow([
        idx + 1,
        sanitizeCellString(`Task #${t.id}`),
        sanitizeCellString(t.type || 'TASK'),
        sanitizeCellString(t.title || 'Задача'),
        sanitizeCellString(t.clientName || 'Клиент'),
        sanitizeCellString(isSupervisor ? (t.phone || '') : (Number(t.managerId) === Number(user.id) ? (t.phone || '') : '***')),
        sanitizeCellString(t.managerName || 'Менеджер'),
        t.dueDate || '—',
        sanitizeCellString(t.priority || 'NORMAL')
      ]);

      row.height = 20;
      row.alignment = { vertical: 'middle' };
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(3).alignment = { horizontal: 'center' };
      row.getCell(8).alignment = { horizontal: 'center' };
      row.getCell(9).alignment = { horizontal: 'center' };

      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
        });
      }
      row.eachCell(cell => { cell.border = thinBorder; });
    });

    sheet7.getColumn(1).width = 6;
    sheet7.getColumn(2).width = 16;
    sheet7.getColumn(3).width = 20;
    sheet7.getColumn(4).width = 24;
    sheet7.getColumn(5).width = 20;
    sheet7.getColumn(6).width = 30;
    sheet7.getColumn(7).width = 24;
    sheet7.getColumn(8).width = 20;
    sheet7.getColumn(9).width = 14;
    sheet7.pageSetup = {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '8:8',
      printArea: `A1:I${sheet7.rowCount}`
    };

    // Generate binary buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }
}
