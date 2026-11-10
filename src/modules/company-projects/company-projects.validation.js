import { z } from 'zod';
import { AppError } from '../../shared/errors/errorHandler.js';

const text = (max = 200) => z.string().trim().max(max);
const positiveId = z.number().int().positive().max(2147483647);
export const companyProjectSchema = z.object({
  name: text().min(1),
  code: text(40).regex(/^[A-Z][A-Z0-9_-]*$/, 'Код: латинские заглавные буквы, цифры, дефис'),
  location: text(300).default(''),
  director_name: text().default(''),
  director_authority: text(1000).default(''),
  partners: z.array(z.object({
    name: text().min(1),
    share_percent: z.number().positive().max(100).refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, 'Доля: не более двух знаков после запятой'),
  }).strict()).max(50).default([]),
  members: z.array(z.object({
    user_id: positiveId,
    project_role: z.enum(['PARTNER', 'DIRECTOR', 'ACCOUNTANT', 'MANAGER', 'CASHIER', 'WAREHOUSE']),
  }).strict()).max(500).default([]),
  complex_ids: z.array(positiveId).max(500).default([]),
  revision: z.number().int().positive().optional(),
}).strict().superRefine((data, ctx) => {
  if (data.partners.length && data.partners.reduce((sum, p) => sum + Math.round(p.share_percent * 100), 0) !== 10000)
    ctx.addIssue({ code: 'custom', path: ['partners'], message: 'Сумма долей партнёров должна составлять 100%' });
  for (const [key, values] of [
    ['partners', data.partners.map(p => p.name.toLocaleLowerCase('ru-RU'))],
    ['members', data.members.map(m => m.user_id)],
    ['complex_ids', data.complex_ids],
  ]) if (new Set(values).size !== values.length)
    ctx.addIssue({ code: 'custom', path: [key], message: 'Уберите повторяющиеся записи' });
});

export function parseCompanyProject(body, updating = false) {
  const result = companyProjectSchema.safeParse(body);
  if (!result.success) throw new AppError(result.error.issues.map(i => i.message).join('; '), 400);
  if (updating && !result.data.revision) throw new AppError('Обновите карточку проекта перед сохранением', 409);
  if (!updating && result.data.revision !== undefined) throw new AppError('Новый проект не должен содержать версию', 400);
  return result.data;
}
