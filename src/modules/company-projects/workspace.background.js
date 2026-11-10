import {getServiceDB} from '../../db/connection.js';
import {AppError} from '../../shared/errors/errorHandler.js';
export async function assertLegacyAutomationAllowed(context){
 const {data,error}=await getServiceDB().rpc('company_project_background_blocked',{p_context:context});
 if(error||typeof data!=='boolean')throw new AppError('Не удалось проверить принадлежность фоновой операции',503,'PROJECT_AUTOMATION_CHECK_FAILED');
 if(data)throw new AppError('Общие фоновые отправки для проектных данных закрыты до настройки правил проекта',409,'PROJECT_AUTOMATION_HELD');
}
