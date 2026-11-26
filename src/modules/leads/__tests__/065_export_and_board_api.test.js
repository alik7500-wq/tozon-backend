import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import ExcelJS from 'exceljs';

const { mockQueryUnified } = vi.hoisted(() => ({
  mockQueryUnified: vi.fn()
}));

vi.mock('../../../middleware/auth.middleware.js', () => ({
  protect: (req, _res, next) => {
    req.user = req._testUser || { id: 1, role: 'DIRECTOR', all_projects_access: true };
    next();
  },
  protectOptional: (_req, _res, next) => next()
}));

vi.mock('../leads.repository.js', () => ({
  LeadsRepository: {
    queryUnified: mockQueryUnified
  }
}));

import leadsRouter from '../leads.router.js';
import { MAX_EXPORT_ROWS } from '../leadFilterValidator.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  });
  return app;
}

describe('R04.1: Streaming Export (.xlsx & csv) >10,000 rows, 413 Limit, and /board API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports >10,000 synthetic rows (10,050 rows) as .xlsx without silent truncation', async () => {
    const totalRows = 10050;
    const pageSize = 500;
    mockQueryUnified.mockImplementation(async (query) => {
      const offset = query.cursor ? Number(query.cursor) : 0;
      const count = Math.min(pageSize, totalRows - offset);
      const leads = Array.from({ length: count }, (_, idx) => {
        const n = offset + idx + 1;
        return {
          id: n,
          id_str: String(n),
          full_name: `Synthetic Lead ${n}`,
          phone: `+992900${String(n).padStart(6, '0')}`,
          stage: 'NEW',
          source_code: 'INSTAGRAM',
          interested_project_name: 'TOZON PLAZA',
          responsible_user_name: 'Rep A',
          created_at_iso_us: '2026-11-25T10:00:00.123456Z'
        };
      });
      const nextOffset = offset + count;
      return {
        leads,
        total: totalRows,
        nextCursor: nextOffset < totalRows ? String(nextOffset) : null,
        stats: { total: totalRows },
        stageCounts: { NEW: totalRows }
      };
    });

    const app = createTestApp();
    const res = await request(app)
      .get('/api/leads/export?stage=NEW')
      .buffer(true)
      .parse((resStream, cb) => {
        const chunks = [];
        resStream.on('data', (c) => chunks.push(c));
        resStream.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['x-export-expected-count']).toBe(String(totalRows));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const sheet = wb.getWorksheet('Лиды');
    expect(sheet.rowCount).toBe(totalRows + 1); // header + 10,050 rows
    expect(sheet.getRow(2).getCell(1).value).toBe('1');
    expect(sheet.getRow(totalRows + 1).getCell(1).value).toBe(String(totalRows));
  }, 20000);

  it('exports >10,000 synthetic rows as CSV when ?format=csv without silent truncation', async () => {
    const totalRows = 10050;
    const pageSize = 500;
    mockQueryUnified.mockImplementation(async (query) => {
      const offset = query.cursor ? Number(query.cursor) : 0;
      const count = Math.min(pageSize, totalRows - offset);
      const leads = Array.from({ length: count }, (_, idx) => {
        const n = offset + idx + 1;
        return { id: n, id_str: String(n), full_name: `Lead ${n}`, stage: 'NEW' };
      });
      const nextOffset = offset + count;
      return {
        leads,
        total: totalRows,
        nextCursor: nextOffset < totalRows ? String(nextOffset) : null
      };
    });

    const app = createTestApp();
    const res = await request(app).get('/api/leads/export?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const dataLines = res.text.trim().split(/\r?\n/);
    expect(dataLines.length).toBe(totalRows + 1);
  });

  it('returns explicit 413 EXPORT_LIMIT_EXCEEDED instead of truncating when total > MAX_EXPORT_ROWS', async () => {
    mockQueryUnified.mockResolvedValueOnce({
      leads: [],
      total: MAX_EXPORT_ROWS + 1,
      nextCursor: null
    });

    const app = createTestApp();
    const res = await request(app).get('/api/leads/export');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('EXPORT_LIMIT_EXCEEDED');
  });

  it('GET /api/leads/board passes boardPerStageLimit and unified filters to queryUnified', async () => {
    mockQueryUnified.mockResolvedValueOnce({
      leads: [],
      total: 27,
      boardColumns: {
        NEW: { leads: [{ id: 1, full_name: 'New 1', stage: 'NEW' }], total: 25, nextCursor: 'cur_new' },
        RESERVED: { leads: [{ id: 201, full_name: 'Res 1', stage: 'RESERVED' }], total: 2, nextCursor: null }
      },
      stageCounts: { NEW: 25, RESERVED: 2 },
      stats: { total: 27 }
    });

    const app = createTestApp();
    const res = await request(app).get('/api/leads/board?projectId=1&perStageLimit=15');
    expect(res.status).toBe(200);
    expect(mockQueryUnified).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: '1', limit: '0', boardPerStageLimit: '15' }),
      expect.any(Object)
    );
    expect(res.body.data.boardColumns.NEW.nextCursor).toBe('cur_new');
    expect(res.body.data.boardColumns.RESERVED.leads).toHaveLength(1);
  });
});
