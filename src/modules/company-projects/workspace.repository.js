import { getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export async function searchWorkspace(actor,project,{q=null,resource=null,record=null}={}){
 const {data,error}=await getServiceDB().rpc('search_company_project_workspace',{p_actor:actor,p_project:project,p_query:q,p_resource:resource,p_record:record});
 if(error?.code==='42501')throw new AppError('Нет доступа к поиску в этом проекте или разделе',403);
 if(error?.code==='P0002')throw new AppError('Запись не найдена или больше недоступна',404);
 if(error?.code==='22023')throw new AppError('Введите от 2 до 100 символов или одну цифру номера',400);
 if(error)throw error;
 return data;
}

export async function readWorkspaceCashBook(actor,project,cashDesk=null){
 const {data,error}=await getServiceDB().rpc('read_company_project_cash_book',{p_actor:actor,p_project:project,p_cash_desk:cashDesk});
 if(error?.code==='42501')throw new AppError('Для кассовой книги нужны права на поступления и расходы этого проекта',403);
 if(error?.code==='P0002')throw new AppError('Касса не найдена в выбранном проекте',404);
 if(error?.code==='23514')throw new AppError('В кассовой истории есть противоречивые связи с проектом. Обратитесь к администратору для сверки.',409);
 if(error?.code==='54000')throw new AppError('В кассе более 5000 документов. Для полного отчёта обратитесь к администратору.',422);
 if(error)throw error;
 return data;
}

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

export async function readWorkspaceStock(actor,project,warehouse=null){
 const {data,error}=await getServiceDB().rpc('read_company_project_stock',{p_actor:actor,p_project:project,p_warehouse:warehouse});
 if(error?.code==='42501')throw new AppError('Нет доступа к складам этого проекта',403);
 if(error?.code==='P0002')throw new AppError('Склад не найден в выбранном проекте',404);
 if(error?.code==='23514')throw new AppError('В складской истории есть противоречивые связи с проектом. Обратитесь к администратору для проверки.',409);
 if(error?.code==='54000')throw new AppError('В складе более 5000 строк остатков. Обратитесь к администратору для разделения отчёта.',422);
 if(error)throw error;
 return data;
}
