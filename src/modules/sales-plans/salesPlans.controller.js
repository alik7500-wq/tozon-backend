import { SalesPlansService } from './salesPlans.service.js';
import { SalesPlansRepository } from './salesPlans.repository.js';
import {
  getPerformanceQuerySchema,
  batchSaveSalesPlansSchema,
  approvePlanSchema,
  dealsBreakdownQuerySchema,
  updateAlertSettingsSchema
} from './salesPlans.validator.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class SalesPlansController {
  /**
   * GET /api/sales-plans/performance
   * Returns plan vs fact performance, pacing, forecast, manager & building breakdowns
   */
  static async getPerformance(req, res, next) {
    try {
      const parsedQuery = getPerformanceQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return next(new AppError(parsedQuery.error.issues[0]?.message || 'Некорректные параметры запроса', 400));
      }

      const data = await SalesPlansService.getPerformanceData(parsedQuery.data, req.user);
      res.status(200).json({
        success: true,
        status: 'success',
        data
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/sales-plans
   * Returns sales plans list for given period
   */
  static async getSalesPlans(req, res, next) {
    try {
      const period = req.query.period;
      if (!period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
        return next(new AppError('Параметр period обязателен и должен быть в формате YYYY-MM', 400));
      }

      const plans = await SalesPlansRepository.getPlansByPeriod(period, req.query);
      res.status(200).json({
        success: true,
        status: 'success',
        data: plans
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/sales-plans/batch
   * Create or update a batch of sales plans (ADMIN only)
   */
  static async batchSavePlans(req, res, next) {
    try {
      const parsedBody = batchSaveSalesPlansSchema.safeParse(req.body);
      if (!parsedBody.success) {
        return next(new AppError(parsedBody.error.issues[0]?.message || 'Некорректные данные планов продаж', 400));
      }

      const data = await SalesPlansService.batchSavePlans(parsedBody.data, req.user);
      res.status(200).json({
        success: true,
        status: 'success',
        message: 'Планы продаж успешно сохранены',
        data
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/sales-plans/:id/approve
   * Approve a plan (ADMIN only)
   */
  static async approvePlan(req, res, next) {
    try {
      const id = req.params.id;
      const parsed = approvePlanSchema.safeParse({ id, reason: req.body?.reason });
      if (!parsed.success) {
        return next(new AppError(parsed.error.issues[0]?.message || 'Некорректный ID плана', 400));
      }

      const data = await SalesPlansService.approvePlan(parsed.data.id, parsed.data.reason, req.user);
      res.status(200).json({
        success: true,
        status: 'success',
        message: 'План продаж успешно утверждён',
        data
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/sales-plans/audit-logs
   * History of sales plan changes (ADMIN only)
   */
  static async getAuditLogs(req, res, next) {
    try {
      const data = await SalesPlansService.getAuditLogs(req.query, req.user);
      res.status(200).json({
        success: true,
        status: 'success',
        data
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/sales-plans/deals
   * Drill-down deals breakdown for Gross / Cancellations / Net
   */
  static async getDealsBreakdown(req, res, next) {
    try {
      const parsedQuery = dealsBreakdownQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return next(new AppError(parsedQuery.error.issues[0]?.message || 'Некорректные параметры расшифровки', 400));
      }

      const data = await SalesPlansService.getDealsBreakdown(parsedQuery.data, req.user);
      res.status(200).json({
        success: true,
        status: 'success',
        data
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/sales-plans/alert-settings
   * Fetch configurable alert thresholds (ADMIN, DIRECTOR)
   */
  static async getAlertSettings(req, res, next) {
    try {
      const role = req.user?.role;
      if (role === 'FINANCE_MANAGER' || role === 'SALES_MANAGER') {
        return next(new AppError('Доступ к настройкам планов продаж запрещен для вашей роли', 403));
      }

      const settings = await SalesPlansRepository.getAlertSettings();
      res.status(200).json({
        success: true,
        status: 'success',
        data: settings
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/sales-plans/alert-settings
   * Update configurable alert thresholds (ADMIN only)
   */
  static async updateAlertSettings(req, res, next) {
    try {
      const role = req.user?.role;
      if (role !== 'ADMIN') {
        return next(new AppError('Только Администратор может изменять настройки порогов контроля', 403));
      }

      const parsed = updateAlertSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new AppError(parsed.error.issues[0]?.message || 'Некорректные параметры настроек', 400));
      }

      const updated = await SalesPlansRepository.updateAlertSettings(parsed.data, req.user?.id);
      res.status(200).json({
        success: true,
        status: 'success',
        message: 'Настройки порогов контроля успешно сохранены',
        data: updated
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/sales-plans/alerts-history
   * View alert events history for sales plans (ADMIN, DIRECTOR, SALES_MANAGER with self-scope)
   */
  static async getAlertsHistory(req, res, next) {
    try {
      const role = req.user?.role;
      if (role === 'FINANCE_MANAGER') {
        return next(new AppError('Доступ к истории планов продаж запрещен для вашей роли', 403));
      }

      const history = await SalesPlansRepository.getAlertsHistory(req.query, req.user);
      res.status(200).json({
        success: true,
        status: 'success',
        data: history
      });
    } catch (error) {
      next(error);
    }
  }
}

