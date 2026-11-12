import ExcelJS from 'exceljs';
import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { getBusinessDate } from '../../utils/businessTime.js';

const getSecureDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CANONICAL_BLOCKS = Object.freeze([
  { projectKey: 'TOZON PLAZA', projectName: 'TOZON PLAZA', blockCode: 'А', blockName: 'Блок А', sortOrder: 1 },
  { projectKey: 'TOZON PLAZA', projectName: 'TOZON PLAZA', blockCode: 'Б', blockName: 'Блок Б', sortOrder: 2 },
  { projectKey: 'TOZON PLAZA-2', projectName: 'TOZON PLAZA-2', blockCode: 'В', blockName: 'Блок В', sortOrder: 3 },
  { projectKey: 'TOZON PLAZA-2', projectName: 'TOZON PLAZA-2', blockCode: 'Г', blockName: 'Блок Г', sortOrder: 4 }
]);

const LATIN_TO_CYRILLIC_BLOCK = {
  A: 'А',
  B: 'Б',
  V: 'В',
  G: 'Г'
};

/**
 * Normalizes project/complex record or query filter to canonical complex name:
 * 'TOZON PLAZA' or 'TOZON PLAZA-2'.
 */
export function normalizeComplexName(input) {
  if (!input) return '';
  const rawName = typeof input === 'object'
    ? `${input.name || ''} ${input.code || ''}`.trim()
    : String(input).trim();

  if (!rawName) return '';
  const upper = rawName.toUpperCase();
  if (upper === 'ALL' || upper === 'ВСЕ') return 'ALL';

  if (
    /(?:PLAZA|ПЛАЗА)[-\s]+2(?:\b|$)/i.test(upper)
  ) {
    return 'TOZON PLAZA-2';
  }

  if (
    upper.includes('TOZON PLAZA') ||
    upper.includes('ТОЗОН ПЛАЗА') ||
    upper.includes('25601')
  ) {
    return 'TOZON PLAZA';
  }

  return rawName.replace(/^ЖК\s+/i, '').trim();
}

/**
 * Normalizes building/block record or query filter to canonical block letter:
 * 'А', 'Б', 'В', 'Г'.
 */
export function normalizeBlockCode(input) {
  if (!input) return '';
  const raw = typeof input === 'object'
    ? `${input.code || ''} ${input.name || ''}`.trim()
    : String(input).trim();

  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (upper === 'ALL' || upper === 'ВСЕ') return 'ALL';

  const singleNormalized = LATIN_TO_CYRILLIC_BLOCK[upper] || upper;
  if (['А', 'Б', 'В', 'Г'].includes(singleNormalized)) {
    return singleNormalized;
  }

  const match = upper.match(/БЛОК[-\s]*([АБВГABVG])/i) || upper.match(/(?:^|[\s-])([АБВГABVG])(?:$|[\s-])/i);
  if (match && match[1]) {
    const ch = match[1].toUpperCase();
    return LATIN_TO_CYRILLIC_BLOCK[ch] || ch;
  }

  return raw.replace(/^Блок\s+/i, '').trim();
}

/**
 * Resolves the contract conclusion date in YYYY-MM-DD format (Asia/Dushanbe).
 * Priority: deal.deal_date -> deal.signed_at -> deal.created_at.
 */
export function resolveContractDate(deal) {
  if (!deal) return null;

  if (deal.deal_date) {
    const raw = String(deal.deal_date).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      return raw.slice(0, 10);
    }
    const parsed = getBusinessDate(raw);
    if (parsed) return parsed;
  }

  if (deal.signed_at) {
    const parsed = getBusinessDate(deal.signed_at);
    if (parsed) return parsed;
  }

  if (deal.created_at) {
    const parsed = getBusinessDate(deal.created_at);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Converts area_m2_x100 integer (or fallback area_m2) to integer hundredths of m².
 */
export function resolveAreaX100(unit) {
  if (!unit) return 0;
  if (unit.area_m2_x100 !== undefined && unit.area_m2_x100 !== null && Number.isFinite(Number(unit.area_m2_x100))) {
    return Math.max(0, Math.round(Number(unit.area_m2_x100)));
  }
  if (unit.area_m2 !== undefined && unit.area_m2 !== null && Number.isFinite(Number(unit.area_m2))) {
    return Math.max(0, Math.round(Number(unit.area_m2) * 100));
  }
  return 0;
}

export function formatAreaM2(areaX100) {
  return Number(((Number(areaX100) || 0) / 100).toFixed(2));
}

export function formatDateRu(isoDate) {
  if (!isoDate || !DATE_RE.test(String(isoDate))) return String(isoDate || '—');
  const [y, m, d] = String(isoDate).split('-');
  return `${d}.${m}.${y}`;
}

export function getDushanbeTimestampLabel(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Dushanbe',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(now);
  } catch {
    return getBusinessDate(now) || '';
  }
}

export class ApartmentSalesReportService {
  /**
   * Resolves default and validated filter parameters.
   * Default period: 1st of current month to today in Asia/Dushanbe.
   */
  static resolveFilters(query = {}, now = new Date()) {
    const today = getBusinessDate(now);
    const firstOfMonth = `${today.slice(0, 8)}01`;

    const startDate = query.startDate ? String(query.startDate).trim() : firstOfMonth;
    const endDate = query.endDate ? String(query.endDate).trim() : today;

    if (!DATE_RE.test(startDate)) {
      throw new AppError('Некорректный формат даты начала периода (ожидается ГГГГ-ММ-ДД)', 400);
    }
    if (!DATE_RE.test(endDate)) {
      throw new AppError('Некорректный формат даты окончания периода (ожидается ГГГГ-ММ-ДД)', 400);
    }
    if (startDate > endDate) {
      throw new AppError('Дата начала периода не может быть позже даты окончания периода', 400);
    }

    const rawComplex = query.complex || query.project || query.projectId || 'ALL';
    const rawBlock = query.block || query.buildingId || 'ALL';

    const complex = normalizeComplexName(rawComplex) || 'ALL';
    let block = normalizeBlockCode(rawBlock) || 'ALL';

    // Ensure selected block is compatible with selected complex
    if (complex === 'TOZON PLAZA' && !['ALL', 'А', 'Б'].includes(block)) {
      block = 'ALL';
    } else if (complex === 'TOZON PLAZA-2' && !['ALL', 'В', 'Г'].includes(block)) {
      block = 'ALL';
    }

    return {
      startDate,
      endDate,
      complex,
      block
    };
  }

  /**
   * Fetches raw buildings and deals with nested unit/floor/section/building/project data from Supabase.
   */
  static async fetchReportDataFromDB(db = getSecureDB()) {
    const [buildingsRes, dealsRes] = await Promise.all([
      db
        .from('buildings')
        .select('id, name, code, sort_order, project_id, archived_at, projects ( id, name, code, archived_at )')
        .is('archived_at', null)
        .order('project_id', { ascending: true })
        .order('sort_order', { ascending: true }),
      db
        .from('deals')
        .select(`
          id,
          unit_id,
          status,
          payment_type,
          contract_number,
          deal_date,
          signed_at,
          created_at,
          cancelled_at,
          units (
            id,
            unit_number,
            unit_kind,
            rooms,
            area_m2_x100,
            status,
            archived_at,
            floors (
              id,
              floor_number,
              name,
              sections (
                id,
                name,
                building_id,
                buildings (
                  id,
                  name,
                  code,
                  sort_order,
                  project_id,
                  projects (
                    id,
                    name,
                    code
                  )
                )
              )
            )
          )
        `)
        .eq('status', 'SIGNED')
        .is('cancelled_at', null)
    ]);

    if (buildingsRes.error) {
      throw new AppError(`Ошибка загрузки блоков: ${buildingsRes.error.message}`, 500);
    }
    if (dealsRes.error) {
      throw new AppError(`Ошибка загрузки договоров: ${dealsRes.error.message}`, 500);
    }

    return {
      buildings: buildingsRes.data || [],
      deals: dealsRes.data || []
    };
  }

  /**
   * Pure calculation engine for the Apartment Sales Report.
   * Can be called directly in unit tests with custom datasets.
   */
  static computeReport({ deals = [], buildings = [], query = {}, now = new Date() }) {
    const filters = this.resolveFilters(query, now);

    // 1. Build canonical block definitions enriched with DB IDs if present
    const blockMetaMap = new Map();
    for (const def of CANONICAL_BLOCKS) {
      const key = `${def.projectKey}::${def.blockCode}`;
      blockMetaMap.set(key, {
        key,
        projectId: null,
        projectName: def.projectName,
        rawProjectName: def.projectName,
        buildingId: null,
        blockCode: def.blockCode,
        blockName: def.blockName,
        sortOrder: def.sortOrder
      });
    }

    for (const b of buildings) {
      if (b?.archived_at) continue;
      const projectObj = Array.isArray(b.projects) ? b.projects[0] : b.projects;
      const projectName = normalizeComplexName(projectObj);
      const blockCode = normalizeBlockCode(b);
      if (!projectName || !blockCode) continue;

      const key = `${projectName}::${blockCode}`;
      const existing = blockMetaMap.get(key);
      if (existing) {
        existing.projectId = projectObj?.id ?? b.project_id ?? existing.projectId;
        existing.rawProjectName = projectObj?.name || existing.rawProjectName;
        existing.buildingId = b.id ?? existing.buildingId;
        existing.blockName = b.name || existing.blockName;
      } else {
        blockMetaMap.set(key, {
          key,
          projectId: projectObj?.id ?? b.project_id ?? null,
          projectName,
          rawProjectName: projectObj?.name || projectName,
          buildingId: b.id ?? null,
          blockCode,
          blockName: b.name || `Блок ${blockCode}`,
          sortOrder: 100 + blockMetaMap.size
        });
      }
    }

    // 2. Filter and deduplicate active apartment sales across all deals
    // Rules:
    // - Deal status must be 'SIGNED' and cancelled_at must be null
    // - Unit must exist, not be archived, and not be in 'FREE' / 'CANCELLED' status (terminated contract)
    // - Unit kind must be 'APARTMENT' (exclude 'COMMERCIAL' and 'PARKING')
    // - Deduplicate by unit_id: each apartment is counted at most once (latest active contract wins)
    const activeByUnitId = new Map();

    for (const deal of deals) {
      if (!deal) continue;
      const dealStatus = String(deal.status || '').toUpperCase();
      if (dealStatus !== 'SIGNED') continue;
      if (deal.cancelled_at) continue;

      const unit = Array.isArray(deal.units) ? deal.units[0] : deal.units;
      if (!unit || unit.archived_at) continue;

      const unitId = deal.unit_id ?? unit.id;
      if (!unitId) continue;

      // Exclude apartments whose unit status was reverted to FREE due to termination
      const unitStatus = String(unit.status || 'SOLD').toUpperCase();
      if (unitStatus === 'FREE' || unitStatus === 'CANCELLED' || unitStatus === 'AVAILABLE') {
        continue;
      }

      // Only APARTMENT (exclude COMMERCIAL and PARKING)
      const unitKind = String(unit.unit_kind || 'APARTMENT').toUpperCase();
      if (unitKind !== 'APARTMENT') continue;

      const contractDate = resolveContractDate(deal);
      if (!contractDate || !DATE_RE.test(contractDate)) continue;

      const floorObj = Array.isArray(unit.floors) ? unit.floors[0] : unit.floors;
      const sectionObj = Array.isArray(floorObj?.sections) ? floorObj.sections[0] : floorObj?.sections;
      const buildingObj = Array.isArray(sectionObj?.buildings) ? sectionObj.buildings[0] : sectionObj?.buildings;
      const projectObj = Array.isArray(buildingObj?.projects) ? buildingObj.projects[0] : buildingObj?.projects;

      const projectName = normalizeComplexName(projectObj || deal.project_name || deal.project);
      const blockCode = normalizeBlockCode(buildingObj || deal.block_code || deal.block);
      if (!projectName || !blockCode) continue;

      const areaX100 = resolveAreaX100(unit);
      const candidate = {
        dealId: deal.id,
        unitId,
        contractDate,
        contractNumber: deal.contract_number || `Договор #${deal.id}`,
        projectId: projectObj?.id ?? buildingObj?.project_id ?? null,
        projectName,
        rawProjectName: projectObj?.name || projectName,
        buildingId: buildingObj?.id ?? sectionObj?.building_id ?? null,
        blockCode,
        blockName: buildingObj?.name || `Блок ${blockCode}`,
        unitNumber: String(unit.unit_number || ''),
        floorNumber: floorObj?.floor_number ?? null,
        rooms: unit.rooms ?? null,
        areaX100,
        areaM2: formatAreaM2(areaX100),
        status: 'SIGNED',
        statusLabel: 'Действующий',
        paymentType: String(deal.payment_type || 'FULL').toUpperCase(),
        signedAt: deal.signed_at || deal.created_at || ''
      };

      const prev = activeByUnitId.get(unitId);
      if (!prev) {
        activeByUnitId.set(unitId, candidate);
      } else {
        // Keep the latest active contract for this apartment
        const prevKey = `${prev.contractDate}::${prev.signedAt}::${String(prev.dealId).padStart(12, '0')}`;
        const nextKey = `${candidate.contractDate}::${candidate.signedAt}::${String(candidate.dealId).padStart(12, '0')}`;
        if (nextKey >= prevKey) {
          activeByUnitId.set(unitId, candidate);
        }
      }
    }

    // 3. Determine which blocks should be displayed according to filters
    const visibleBlockMetas = Array.from(blockMetaMap.values())
      .filter((meta) => {
        if (filters.complex !== 'ALL' && meta.projectName !== filters.complex) return false;
        if (filters.block !== 'ALL' && meta.blockCode !== filters.block) return false;
        return true;
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const rowsByKey = new Map();
    for (const meta of visibleBlockMetas) {
      rowsByKey.set(meta.key, {
        key: meta.key,
        projectId: meta.projectId,
        projectName: meta.projectName,
        rawProjectName: meta.rawProjectName,
        buildingId: meta.buildingId,
        blockCode: meta.blockCode,
        blockName: meta.blockName,
        soldCount: 0,
        soldAreaX100: 0,
        soldAreaM2: 0,
        apartments: []
      });
    }

    // 4. Filter deduplicated apartment sales by period [startDate, endDate] inclusive and complex/block
    const matchingSales = [];
    for (const sale of activeByUnitId.values()) {
      if (sale.contractDate < filters.startDate || sale.contractDate > filters.endDate) {
        continue;
      }
      if (filters.complex !== 'ALL' && sale.projectName !== filters.complex) {
        continue;
      }
      if (filters.block !== 'ALL' && sale.blockCode !== filters.block) {
        continue;
      }

      const key = `${sale.projectName}::${sale.blockCode}`;
      let blockRow = rowsByKey.get(key);
      if (!blockRow) {
        blockRow = {
          key,
          projectId: sale.projectId,
          projectName: sale.projectName,
          rawProjectName: sale.rawProjectName,
          buildingId: sale.buildingId,
          blockCode: sale.blockCode,
          blockName: sale.blockName,
          soldCount: 0,
          soldAreaX100: 0,
          soldAreaM2: 0,
          apartments: []
        };
        rowsByKey.set(key, blockRow);
      }

      blockRow.soldCount += 1;
      blockRow.soldAreaX100 += sale.areaX100;
      blockRow.apartments.push({
        dealId: sale.dealId,
        contractDate: sale.contractDate,
        contractNumber: sale.contractNumber,
        projectId: sale.projectId,
        projectName: sale.projectName,
        buildingId: sale.buildingId,
        blockCode: sale.blockCode,
        blockName: sale.blockName,
        unitId: sale.unitId,
        unitNumber: sale.unitNumber,
        floorNumber: sale.floorNumber,
        rooms: sale.rooms,
        areaM2: sale.areaM2,
        status: sale.status,
        statusLabel: sale.statusLabel,
        paymentType: sale.paymentType
      });

      matchingSales.push(sale);
    }

    // 5. Finalize per-block totals and sort drilldown apartments
    let totalSoldCount = 0;
    let totalAreaX100 = 0;

    const blocks = Array.from(rowsByKey.values()).map((row) => {
      row.apartments.sort((a, b) => {
        if (a.contractDate !== b.contractDate) return a.contractDate.localeCompare(b.contractDate);
        return String(a.unitNumber).localeCompare(String(b.unitNumber), 'ru', { numeric: true });
      });
      row.soldAreaM2 = formatAreaM2(row.soldAreaX100);
      totalSoldCount += row.soldCount;
      totalAreaX100 += row.soldAreaX100;

      const { soldAreaX100, ...publicRow } = row;
      return publicRow;
    });

    const totalAreaM2 = formatAreaM2(totalAreaX100);
    const averageAreaM2 = totalSoldCount > 0
      ? formatAreaM2(Math.round(totalAreaX100 / totalSoldCount))
      : 0;

    const allApartments = blocks.flatMap((b) => b.apartments);

    return {
      generatedAt: new Date(now).toISOString(),
      generatedAtLabel: getDushanbeTimestampLabel(now),
      timezone: 'Asia/Dushanbe',
      filters,
      summary: {
        totalSoldCount,
        totalAreaM2,
        averageAreaM2
      },
      blocks,
      totals: {
        soldCount: totalSoldCount,
        soldAreaM2: totalAreaM2
      },
      apartments: allApartments
    };
  }

  /**
   * Main service entrypoint for GET /api/reports/apartment-sales
   */
  static async getApartmentSalesReport(query = {}, _user = null, db = getSecureDB()) {
    const filters = this.resolveFilters(query);
    const { buildings, deals } = await this.fetchReportDataFromDB(db);
    return this.computeReport({ deals, buildings, query: filters });
  }

  /**
   * Generates a 2-sheet Excel (.xlsx) workbook for the Apartment Sales Report.
   * Sheet 1: Сводный отчёт (Title, Period, Applied Filters, Summary KPIs, Block Table + ИТОГО)
   * Sheet 2: Детализация квартир (Full list of sold apartments in period + ИТОГО)
   */
  static async generateExcelWorkbook(query = {}, user = null, db = getSecureDB(), precomputedReport = null) {
    const report = precomputedReport || (await this.getApartmentSalesReport(query, user, db));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TOZON CRM';
    workbook.created = new Date();

    const complexFilterLabel = report.filters.complex === 'ALL' ? 'Все жилые комплексы' : report.filters.complex;
    const blockFilterLabel = report.filters.block === 'ALL' ? 'Все блоки' : `Блок ${report.filters.block}`;
    const periodLabel = `${formatDateRu(report.filters.startDate)} — ${formatDateRu(report.filters.endDate)}`;

    // =========================================================================
    // SHEET 1: Сводный отчёт
    // =========================================================================
    const summarySheet = workbook.addWorksheet('Сводный отчёт', {
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 }
    });

    summarySheet.columns = [
      { key: 'complex', width: 28 },
      { key: 'block', width: 16 },
      { key: 'soldCount', width: 24 },
      { key: 'soldArea', width: 26 }
    ];

    const titleRow = summarySheet.addRow(['ОТЧЁТ О ПРОДАЖАХ КВАРТИР']);
    summarySheet.mergeCells('A1:D1');
    titleRow.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF0F172A' } };
    titleRow.height = 24;

    summarySheet.addRow(['Выбранный период:', periodLabel, 'Дата формирования:', `${report.generatedAtLabel} (Asia/Dushanbe)`]);
    summarySheet.addRow(['Жилой комплекс:', complexFilterLabel, 'Блок:', blockFilterLabel]);
    summarySheet.addRow([]);

    // Summary KPIs section
    const kpiHeaderRow = summarySheet.addRow(['Сводные показатели', '', '', '']);
    summarySheet.mergeCells(`A${kpiHeaderRow.number}:D${kpiHeaderRow.number}`);
    kpiHeaderRow.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF1E293B' } };

    const kpi1 = summarySheet.addRow(['Всего продано квартир, шт.', report.summary.totalSoldCount, '', '']);
    kpi1.getCell(2).numFmt = '#,##0';
    kpi1.getCell(2).font = { bold: true };

    const kpi2 = summarySheet.addRow(['Общая площадь проданных квартир, м²', report.summary.totalAreaM2, '', '']);
    kpi2.getCell(2).numFmt = '#,##0.00';
    kpi2.getCell(2).font = { bold: true };

    const kpi3 = summarySheet.addRow(['Средняя площадь одной проданной квартиры, м²', report.summary.averageAreaM2, '', '']);
    kpi3.getCell(2).numFmt = '#,##0.00';
    kpi3.getCell(2).font = { bold: true };

    summarySheet.addRow([]);

    // Main Table Header
    const tableHeaderRow = summarySheet.addRow([
      'Жилой комплекс',
      'Блок',
      'Продано квартир, шт.',
      'Проданная площадь, м²'
    ]);
    tableHeaderRow.height = 22;
    tableHeaderRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber >= 3 ? 'right' : colNumber === 2 ? 'center' : 'left'
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });

    for (const block of report.blocks) {
      const row = summarySheet.addRow([
        block.projectName,
        block.blockCode,
        block.soldCount,
        block.soldAreaM2
      ]);
      row.height = 20;
      row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
      row.getCell(3).numFmt = '#,##0';
      row.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
      row.getCell(4).numFmt = '#,##0.00';

      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
      });
    }

    const totalRow = summarySheet.addRow([
      'ИТОГО',
      '',
      report.totals.soldCount,
      report.totals.soldAreaM2
    ]);
    totalRow.height = 22;
    totalRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF0F172A' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber >= 3 ? 'right' : 'left'
      };
      cell.border = {
        top: { style: 'medium', color: { argb: 'FF94A3B8' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'double', color: { argb: 'FF475569' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });
    totalRow.getCell(3).numFmt = '#,##0';
    totalRow.getCell(4).numFmt = '#,##0.00';

    // =========================================================================
    // SHEET 2: Детализация квартир
    // =========================================================================
    const detailsSheet = workbook.addWorksheet('Детализация квартир', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
    });

    detailsSheet.columns = [
      { key: 'index', width: 8 },
      { key: 'contractDate', width: 16 },
      { key: 'contractNumber', width: 22 },
      { key: 'projectName', width: 22 },
      { key: 'blockCode', width: 10 },
      { key: 'unitNumber', width: 16 },
      { key: 'floorNumber', width: 10 },
      { key: 'areaM2', width: 22 },
      { key: 'statusLabel', width: 18 }
    ];

    const detailTitle = detailsSheet.addRow([
      `ДЕТАЛИЗАЦИЯ ПРОДАННЫХ КВАРТИР (${periodLabel})`
    ]);
    detailsSheet.mergeCells('A1:I1');
    detailTitle.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FF0F172A' } };
    detailTitle.height = 24;

    detailsSheet.addRow([
      'Фильтры:',
      `ЖК: ${complexFilterLabel}; Блок: ${blockFilterLabel}`,
      '',
      '',
      'Сформировано:',
      `${report.generatedAtLabel} (Asia/Dushanbe)`
    ]);
    detailsSheet.addRow([]);

    const detailHeader = detailsSheet.addRow([
      '№',
      'Дата договора',
      'Номер договора',
      'Жилой комплекс',
      'Блок',
      'Номер квартиры',
      'Этаж',
      'Площадь квартиры, м²',
      'Статус договора'
    ]);
    detailHeader.height = 22;
    detailHeader.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber === 8 ? 'right' : [1, 2, 5, 6, 7].includes(colNumber) ? 'center' : 'left'
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });

    report.apartments.forEach((apt, idx) => {
      const row = detailsSheet.addRow([
        idx + 1,
        formatDateRu(apt.contractDate),
        apt.contractNumber,
        apt.projectName,
        apt.blockCode,
        apt.unitNumber,
        apt.floorNumber ?? '—',
        apt.areaM2,
        apt.statusLabel
      ]);
      row.height = 19;
      row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(4).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(8).alignment = { vertical: 'middle', horizontal: 'right' };
      row.getCell(8).numFmt = '#,##0.00';
      row.getCell(9).alignment = { vertical: 'middle', horizontal: 'left' };

      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
      });
    });

    const detailTotalRow = detailsSheet.addRow([
      'ИТОГО',
      '',
      `Квартир: ${report.totals.soldCount} шт.`,
      '',
      '',
      '',
      '',
      report.totals.soldAreaM2,
      ''
    ]);
    detailTotalRow.height = 22;
    detailTotalRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF0F172A' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber === 8 ? 'right' : 'left'
      };
      cell.border = {
        top: { style: 'medium', color: { argb: 'FF94A3B8' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'double', color: { argb: 'FF475569' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });
    detailTotalRow.getCell(8).numFmt = '#,##0.00';

    return workbook.xlsx.writeBuffer();
  }
}
