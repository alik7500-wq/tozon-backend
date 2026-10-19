import { Router } from 'express';
import { ReportsRepository } from './reports.repository.js';
import { ManagerPerformanceService } from './managerPerformance.service.js';
import { SalesAnalyticsService } from './salesAnalytics.service.js';
import { SalesControlService } from './salesControl.service.js';
import { DailyBriefingService } from './dailyBriefing.service.js';
import { WeeklyDynamicsService } from './weeklyDynamics.service.js';
import { BlockPlanFactService } from './blockPlanFact.service.js';
import { SalesManagementExportService } from './salesManagementExport.service.js';
import { protect } from '../../middleware/auth.middleware.js';

const router = Router();

// Protect all reports routes
router.use(protect);

router.get('/analytics-1', async (req, res, next) => {
  try {
    const filters = {
      projectId: req.query.projectId,
      unitType: req.query.unitType,
    };
    const data = await ReportsRepository.getAnalyticsOne(filters);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics-2', async (req, res, next) => {
  try {
    const filters = {
      projectId: req.query.projectId,
      year: req.query.year,
    };
    const data = await ReportsRepository.getAnalyticsTwo(filters);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics-3', async (req, res, next) => {
  try {
    const filters = {
      projectId: req.query.projectId,
      year: req.query.year,
    };
    const data = await ReportsRepository.getAnalyticsThree(filters);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    const data = await ReportsRepository.getSummaryReports();
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/manager-performance', async (req, res, next) => {
  try {
    const filters = {
      period: req.query.period,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      managerId: req.query.managerId,
      projectId: req.query.projectId
    };
    const data = await ManagerPerformanceService.getPerformanceData(filters, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

// Phase 3.5: Sales Launch Analytics Suite
router.get('/sales-plan-fact', async (req, res, next) => {
  try {
    const data = await SalesAnalyticsService.getPlanFactAnalytics(req.query, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/sales-funnel', async (req, res, next) => {
  try {
    const data = await SalesAnalyticsService.getSalesFunnelAnalytics(req.query, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/sales-managers', async (req, res, next) => {
  try {
    const data = await SalesAnalyticsService.getEnhancedManagerPerformance(req.query, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/apartment-demand', async (req, res, next) => {
  try {
    const data = await SalesAnalyticsService.getApartmentDemandAnalytics(req.query, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/sales-analytics-export', async (req, res, next) => {
  try {
    const exportType = req.query.type || 'plan_fact';
    const csvContent = await SalesAnalyticsService.exportSalesAnalyticsCsv(exportType, req.query, req.user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tozon_sales_analytics_${exportType}.csv"`);
    res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
});

// Phase 3.6: Sales Supervisor Control Dashboard
router.get('/sales-control', async (req, res, next) => {
  try {
    const data = await SalesControlService.getControlDashboardData(req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

// Phase 3.7.1: Daily Briefing, Weekly Dynamics & Block Plan-Fact
router.get('/daily-briefing', async (req, res, next) => {
  try {
    const data = await DailyBriefingService.getDailyBriefing(req.query, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/weekly-dynamics', async (req, res, next) => {
  try {
    const data = await WeeklyDynamicsService.getWeeklyDynamics(req.query, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

router.get('/plan-fact/blocks', async (req, res, next) => {
  try {
    const data = await BlockPlanFactService.getBlockPlanFact(req.query, req.user);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});

// Phase 3.7.3: Sales Management Multi-Sheet Excel Workbook Export
router.get('/sales-management/export.xlsx', async (req, res, next) => {
  try {
    const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(req.query, req.user);
    const dateStr = req.query.date || new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tozon-sales-management-${dateStr}.xlsx"`);
    res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

export default router;
