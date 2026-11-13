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

export async function readWorkspaceOptions(actor, project, kind, { after = '', limit = 100 } = {}) {
  const { data, error } = await getServiceDB().rpc('company_project_operation_options', { p_actor: actor, p_project: project, p_kind: kind, p_after: after, p_limit: limit });
  if (error?.code === '42501') throw new AppError('Нет доступа к справочнику этого проекта', 403);
  if (error) throw error;
  return data;
}

export async function readWorkspaceOverview(actor,project){
  const {data,error}=await getServiceDB().rpc('read_company_project_overview',{p_actor:actor,p_project:project});
  if(error?.code==='42501')throw new AppError('Нет доступа к обзору этого проекта',403);
  if(error)throw error;
  return data;
}

export async function readWorkspaceInventory(actor,project,complex=null){
  const {data,error}=await getServiceDB().rpc('read_company_project_inventory',{p_actor:actor,p_project:project,p_complex:complex});
  if(error?.code==='42501')throw new AppError('Нет доступа к помещениям этого проекта',403);
  if(error?.code==='P0002')throw new AppError('Жилой комплекс не найден в выбранном проекте',404);
  if(error?.code==='54000')throw new AppError('В ЖК более 5000 помещений. Обратитесь к администратору для разделения шахматки.',422);
  if(error)throw error;
  return data;
}
