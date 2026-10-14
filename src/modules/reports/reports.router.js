import { Router } from 'express';
import { ReportsRepository } from './reports.repository.js';
import { ManagerPerformanceService } from './managerPerformance.service.js';
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

export default router;
