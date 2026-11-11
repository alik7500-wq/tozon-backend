import { getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export async function projectRegistry() {
  const db = getServiceDB();
  const requests = await Promise.all([
    db.from('crm_companies').select('id,code,name').eq('code', 'TOZON').single(),
    db.from('company_projects').select('*,partners:company_project_partners(name,share_percent),members:company_project_memberships(user_id,project_role),complexes:company_project_complexes(complex_id)').order('created_at'),
    db.from('projects').select('id,name,code').is('archived_at', null).order('id'),
    db.from('users').select('id,name,role,is_active').order('id'),
  ]);
  for (const result of requests) if (result.error) throw result.error;
  const company = requests[0].data;
  return {
    company,
    projects: requests[1].data.filter(p => p.company_id === company.id).map(({ complexes, ...p }) => ({ ...p, complex_ids: complexes.map(c => c.complex_id) })),
    complexes: requests[2].data,
    users: requests[3].data.filter(u => u.is_active === 1 || u.is_active === true),
    isolation_ready: false,
  };
}

export async function saveCompanyProject(id, payload, actorId) {
  const { revision, ...data } = payload;
  const { data: project, error } = await getServiceDB().rpc('save_company_project_draft', {
    p_project_id: id, p_expected_revision: revision || null, p_payload: data, p_actor_id: actorId,
  });
  if (error) {
    const message = String(error.message || '');
    if (message.includes('COMPLEX_HAS_PROJECT_HISTORY')) throw new AppError('ЖК связан с проектными договорами. Сначала требуется отдельный перенос истории.',409);
    if (message.includes('MEMBERSHIP_HAS_ACCESS_HISTORY')) throw new AppError('У сотрудника есть история проектного доступа. Отключите доступ в отдельном блоке; удаление назначения запрещено.',409);
    if (message.includes('STALE_PROJECT')) throw new AppError('Проект изменён другим пользователем. Обновите список и повторите.', 409);
    if (message.includes('ADMIN_REQUIRED')) throw new AppError('Недостаточно прав для управления проектами', 403);
    if (message.includes('PROJECT_NOT_FOUND')) throw new AppError('Проект не найден', 404);
    if (error.code === '23505') throw new AppError('Код проекта уже занят или выбранный ЖК привязан к другому проекту', 409);
    if (['23503', '23514', '22023', '22P02'].includes(error.code)) throw new AppError('Проверьте доли, сотрудников и привязку ЖК', 400);
    throw error;
  }
  return project;
}
