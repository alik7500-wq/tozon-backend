import { z } from 'zod';

export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Период должен быть в формате YYYY-MM');

export const getPerformanceQuerySchema = z.object({
  period: periodSchema.optional(),
  managerId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  buildingId: z.coerce.number().int().positive().optional(),
});

export const planItemSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  scope_type: z.enum(['DEPARTMENT', 'MANAGER', 'PROJECT', 'BUILDING'], {
    errorMap: () => ({ message: 'scope_type должен быть DEPARTMENT, MANAGER, PROJECT или BUILDING' })
  }),
  manager_id: z.coerce.number().int().positive().nullable().optional(),
  project_id: z.coerce.number().int().positive().nullable().optional(),
  building_id: z.coerce.number().int().positive().nullable().optional(),
  target_deals_count: z.coerce.number().int().nonnegative('Количество договоров должно быть >= 0').default(0),
  target_volume_minor: z.coerce.number().int().nonnegative('Объем в центах должен быть >= 0').default(0),
  currency: z.string().default('USD').refine(val => val === 'USD', { message: 'Валюта должна быть USD' }),
  status: z.enum(['DRAFT', 'APPROVED', 'ACTIVE_LOCKED']).optional().default('DRAFT'),
}).superRefine((data, ctx) => {
  if (data.scope_type === 'DEPARTMENT') {
    if (data.manager_id || data.project_id || data.building_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Для плана DEPARTMENT поля manager_id, project_id и building_id должны быть пустыми',
        path: ['scope_type']
      });
    }
  } else if (data.scope_type === 'MANAGER') {
    if (!data.manager_id || data.project_id || data.building_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Для плана MANAGER требуется manager_id, а project_id и building_id должны быть пустыми',
        path: ['manager_id']
      });
    }
  } else if (data.scope_type === 'PROJECT') {
    if (!data.project_id || data.manager_id || data.building_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Для плана PROJECT требуется project_id, а manager_id и building_id должны быть пустыми',
        path: ['project_id']
      });
    }
  } else if (data.scope_type === 'BUILDING') {
    if (!data.building_id || data.manager_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Для плана BUILDING требуется building_id, а manager_id должен быть пустым',
        path: ['building_id']
      });
    }
  }
});

export const batchSaveSalesPlansSchema = z.object({
  period: periodSchema,
  plans: z.array(planItemSchema).min(1, 'Список планов не может быть пустым'),
  reason: z.string().trim().optional(),
});

export const approvePlanSchema = z.object({
  id: z.coerce.number().int().positive(),
  reason: z.string().trim().optional(),
});

export const dealsBreakdownQuerySchema = z.object({
  period: periodSchema,
  type: z.enum(['GROSS', 'CANCELLATIONS', 'NET']).optional().default('GROSS'),
  managerId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  buildingId: z.coerce.number().int().positive().optional(),
});

export const updateAlertSettingsSchema = z.object({
  behind_schedule_threshold_pp: z.coerce.number().min(1.0, 'Порог отставания должен быть >= 1.0%').max(90.0, 'Порог отставания должен быть <= 90.0%'),
  at_risk_forecast_threshold_pct: z.coerce.number().min(10.0, 'Порог риска прогноза должен быть >= 10.0%').max(99.0, 'Порог риска прогноза должен быть <= 99.0%'),
  min_elapsed_working_days: z.coerce.number().int().min(0, 'Льготный период должен быть >= 0').max(15, 'Льготный период должен быть <= 15 дней'),
  notify_achieved_enabled: z.boolean().optional().default(true),
  weekly_digest_enabled: z.boolean().optional().default(true),
  weekly_digest_day_of_week: z.coerce.number().int().min(1).max(7).optional().default(1),
  weekly_digest_hour: z.coerce.number().int().min(0).max(23).optional().default(9)
});

