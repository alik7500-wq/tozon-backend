import express from 'express';
import { SalesPlansController } from './salesPlans.controller.js';
import { protect } from '../../middleware/auth.middleware.js';

const router = express.Router();

// All routes are protected by authentication token / session
router.use(protect);

// GET /api/sales-plans/performance - Performance summary, pacing, forecast, manager & building tables
router.get('/performance', SalesPlansController.getPerformance);

// GET /api/sales-plans/audit-logs - History of adjustments (ADMIN only)
router.get('/audit-logs', SalesPlansController.getAuditLogs);

// GET /api/sales-plans/deals - Drill-down list of contracts for Gross, Cancellations, Net
router.get('/deals', SalesPlansController.getDealsBreakdown);

// GET /api/sales-plans/alert-settings - Fetch configurable alert thresholds (ADMIN, DIRECTOR)
router.get('/alert-settings', SalesPlansController.getAlertSettings);

// PUT /api/sales-plans/alert-settings - Update configurable alert thresholds (ADMIN only)
router.put('/alert-settings', SalesPlansController.updateAlertSettings);

// GET /api/sales-plans/alerts-history - View alert events history (ADMIN, DIRECTOR, SALES_MANAGER with self-scope)
router.get('/alerts-history', SalesPlansController.getAlertsHistory);

// GET /api/sales-plans - List of raw sales plans for a period
router.get('/', SalesPlansController.getSalesPlans);

// POST /api/sales-plans/batch - Batch create or update plans (ADMIN only)
router.post('/batch', SalesPlansController.batchSavePlans);

// POST /api/sales-plans/:id/approve - Approve a plan (ADMIN only)
router.post('/:id/approve', SalesPlansController.approvePlan);

export default router;
