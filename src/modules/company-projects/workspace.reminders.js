import {getServiceDB} from '../../db/connection.js';
import {AppError} from '../../shared/errors/errorHandler.js';
import {assertWorkspacePilotRuntime} from './workspace.boundary.js';
export function assertInternalReminders(){
 if(process.env.PROJECT_INTERNAL_REMINDERS_ENABLED!=='true')throw new AppError('Внутренние напоминания проектов ещё не включены',404);
 assertWorkspacePilotRuntime();
}
export async function reminderRpc(name,args){
 const {data,error}=await getServiceDB().rpc(name,args);
 if(error?.code==='42501')throw new AppError('Нет права на напоминания этого проекта',403);
 if(error?.code==='P0002')throw new AppError('Проект или напоминание не найдено',404);
 if(error?.code==='40001')throw new AppError('Настройки уже изменены. Обновите их перед сохранением.',409);
 if(error?.code==='22023'||error?.code==='23514')throw new AppError('Проверьте начальную дату и срок напоминания',400);
 if(error)throw error;return data;
}
export async function refreshProjectReminders(){
 if(process.env.PROJECT_INTERNAL_REMINDERS_ENABLED!=='true')return {enabled:false,added:0,failed:0};
 assertInternalReminders();const db=getServiceDB();
 const {data,error}=await db.from('company_project_reminder_settings').select('company_project_id').eq('enabled',true);
 if(error)throw error;let added=0,failed=0;
 for(const p of data||[]){try{added+=await reminderRpc('refresh_company_project_reminders',{p_project:p.company_project_id});}catch{failed++;}}
 return {enabled:true,added,failed};
}
