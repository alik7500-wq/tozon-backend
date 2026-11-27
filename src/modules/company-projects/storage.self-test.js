import {randomUUID,createHash} from 'node:crypto';
import {privateStorage,PRIVATE_BUCKET} from './workspace.documents.js';
import {setupRpc} from './company-projects.setup.js';
import {assertWorkspacePilotRuntime} from './workspace.boundary.js';
import {AppError} from '../../shared/errors/errorHandler.js';

// Administrative diagnostics only: never impersonates a project employee,
// reads a contract, registers a business attachment, or touches existing files.
export async function checkProjectStorage(actor,project){
 assertWorkspacePilotRuntime();
 if(!['PROJECT_WORKSPACE_DOCUMENTS_ENABLED','PROJECT_WORKSPACE_FILES_ENABLED','PROJECT_WORKSPACE_WRITES_ENABLED'].every(k=>process.env[k]==='true'))throw new AppError('Проверка файлов в тестовом пилоте выключена',503);
 const authorize=()=>setupRpc('read_company_project_setup',{p_actor:actor,p_project:project});
 await authorize();
 const base=new URL(process.env.NODE_ENV==='test'?process.env.TEST_SUPABASE_URL:process.env.SUPABASE_URL);
 // No path, credentials, alternate origin or user-controlled URL.
 if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||base.port)throw new AppError('Некорректный адрес тестового хранилища',503);
 const path=`${project}/_diagnostics/${randomUUID()}.pdf`;
 const buffer=Buffer.from('%PDF-1.4\n% TOZON CRM storage diagnostic - no business data\n%%EOF\n');
 const digest=b=>createHash('sha256').update(b).digest('hex');
 const store=await privateStorage(true);
 try{
  const upload=await store.upload(path,buffer,{contentType:'application/pdf',upsert:false,cacheControl:'0'});
  if(upload.error)throw upload.error;
  await authorize();
  const download=await store.download(path);if(download.error)throw download.error;
  const actual=Buffer.from(await download.data.arrayBuffer());
  if(actual.length!==buffer.length||digest(actual)!==digest(buffer))throw new AppError('Не совпало содержимое тестового файла',503);
  for(const route of ['public','authenticated']){
   const response=await fetch(`${base.origin}/storage/v1/object/${route}/${PRIVATE_BUCKET}/${path}`,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
   await response.body?.cancel();
   if(![400,401,403,404].includes(response.status))throw new AppError('Не подтверждено закрытие файла от анонимного доступа',503);
  }
  await authorize();
 }finally{
  // Even an uncertain upload can have committed. Only our unguessable path is removed.
  const cleanup=await store.remove([path]);
  if(cleanup.error)throw new AppError('Не подтверждено удаление служебного файла проверки. Повторите проверку позже.',503);
  const absent=await store.download(path);
  if(!absent.error||![400,404].includes(Number(absent.error.statusCode||absent.error.status))||!/not found|does not exist/i.test(absent.error.message||''))throw new AppError('Хранилище не подтвердило удаление служебного файла',503);
 }
 return {upload:true,download:true,integrity:true,anonymous_denied:true,cleanup:true,checked_at:new Date().toISOString()};
}
