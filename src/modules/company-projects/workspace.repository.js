import { getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export async function readWorkspace(actor, project, resource, { record = null, after = '', limit = 50 } = {}) {
  const { data, error } = await getServiceDB().rpc('read_company_project_workspace', {
    p_actor: actor, p_project: project, p_resource: resource, p_record: record, p_after: after, p_limit: limit,
  });
  if (error?.code === '42501') throw new AppError('Нет доступа к этому проекту или разделу', 403);
  if (error?.code === 'P0002') throw new AppError('Запись не найдена', 404);
  if (error?.code === '22023') throw new AppError('Некорректный запрос рабочего пространства', 400);
  if (error) throw error;
  return data;
}
