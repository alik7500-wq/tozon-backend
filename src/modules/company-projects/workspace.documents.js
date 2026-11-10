import {createHash} from 'node:crypto';
import {getServiceDB} from '../../db/connection.js';
import {AppError} from '../../shared/errors/errorHandler.js';
import {compileTemplate,renderTemplate,MIME} from '../document-settings/template.engine.js';
export const PRIVATE_BUCKET='company-project-private';
export const FILE_LIMIT=10*1024*1024;
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
const meta=f=>({id:f.id,original_name:f.original_name,content_type:f.content_type,file_size:f.file_size,created_at:f.created_at});
async function rpc(name,args){
 const {data,error}=await getServiceDB().rpc(name,args);
 if(error?.code==='42501')throw new AppError('Нет доступа к документам этого проекта',403);
 if(error?.code==='P0002')throw new AppError('Документ не найден',404);
 if(error?.code==='23514')throw new AppError('Документ требует проверки принадлежности кассы и валютных данных',409);
 if(error?.code==='23505')throw new AppError('Этот ключ загрузки уже использован с другими данными',409);
 if(error)throw error;return data;
}
const args=(actor,project,deal)=>({p_actor:actor,p_project:project,p_deal:deal});
export const authorizeDocument=(actor,project,deal,write=false)=>rpc('authorize_company_project_document',{...args(actor,project,deal),p_write:write});
export const readDocument=(actor,project,deal)=>rpc('read_company_project_document',args(actor,project,deal));
export const readFiles=(actor,project,deal,file=null,after='',limit=100)=>rpc('read_company_project_files',{...args(actor,project,deal),p_file:file,p_after:after,p_limit:limit});
export async function documentDetails(actor,project,deal){
 const data=await readDocument(actor,project,deal);
 const {data:templates,error}=await getServiceDB().from('crm_document_templates').select('kind,language,scope,name').eq('active',true).in('kind',['CONTRACT','SCHEDULE']).in('scope',['*',String(data.unit.project_id)]).order('created_at',{ascending:false}).limit(100);
 if(error)throw error;
 return {...data,templates:(templates||[]).filter(t=>t.kind!=='SCHEDULE'||data.financial),files_upload:data.files_upload&&process.env.PROJECT_WORKSPACE_WRITES_ENABLED==='true'&&process.env.PROJECT_WORKSPACE_FILES_ENABLED==='true'};
}
const money=v=>v==null?'—':(Number(v)/100).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
const day=v=>String(v||'').slice(0,10).replace(/^(\d{4})-(\d{2})-(\d{2})$/,'$3.$2.$1')||'—';
export function documentContext(data){
 const {deal:d,client:c,unit:u,signer:s,company}=data;
 const context={...Object.fromEntries(['company_inn','company_address','company_phone','company_bank','company_account'].map(k=>[k,company?.[k]||''])),company_name:s?.company_name||'',director_name:s?.director_name||'',director_authority:s?.director_authority||'',branch_name:u.project_name,
 document_number:d.contract_number||'',document_date:day(d.deal_date),contract_number:d.contract_number||'',contract_date:day(d.deal_date),client_name:c.full_name,client_phone:c.phone,client_inn:c.inn,passport_number:[c.passport_series,c.passport_number].filter(Boolean).join(' '),passport_issued_by:c.passport_issued_by,passport_issue_date:day(c.passport_issue_date),client_address:c.registration_address,birth_date:day(c.birth_date),project_name:u.project_name,project_address:u.project_address,building_name:u.building_name,section_name:u.section_name,floor_number:u.floor_number,unit_number:u.unit_number,rooms:u.rooms,area:Number(u.area_m2_x100)/100,price_per_m2:money(d.deal_price_per_m2_minor),contract_total:money(d.final_price_minor),currency:d.currency,down_payment:money(d.down_payment_minor),total_paid:data.financial?money(data.total_paid_minor):'—',remaining_debt:data.financial?money(Math.max(0,Number(d.final_price_minor)-Number(data.total_paid_minor))):'—',payment_type:d.payment_type,
 schedules:(data.schedules||[]).map((r,i)=>({row_number:i+1,due_date:day(r.due_date),planned_amount:money(r.amount_minor),paid_amount:money(r.paid_amount_minor),balance:money(r.amount_minor-r.paid_amount_minor),status:r.status}))};
 return Object.fromEntries(Object.entries(context).map(([key,value])=>[key,value??null]));
}
export async function downloadTemplate(actor,project,deal,kind,language){
 const data=await readDocument(actor,project,deal);
 if(data.deal.status!=='SIGNED'||!data.signer?.company_name?.trim()||!data.signer?.director_name?.trim()||!data.signer?.director_authority?.trim())throw new AppError('Для печати нужен подписанный проектный договор со снимком директора',409);
 if(kind==='SCHEDULE'&&!data.financial)throw new AppError('Нет доступа к графику платежей',403);
 const db=getServiceDB();let row;
 // Always prefer this residential complex. Never accept template IDs or context from the browser.
 for(const scope of [String(data.unit.project_id),'*']){
  const r=await db.from('crm_document_templates').select('file_base64').eq('active',true).eq('kind',kind).eq('language',language).eq('scope',scope).order('created_at',{ascending:false}).limit(1).maybeSingle();
  if(r.error)throw r.error;if(r.data){row=r.data;break;}
 }
 if(!row)throw new AppError('Для этого ЖК и языка нет действующего бланка. Администратор должен добавить его в настройках.',404);
 const buffer=Buffer.from(row.file_base64,'base64');
 const text=compileTemplate(buffer).getFullText();
 if(!data.financial&&/\{(?:#schedules|total_paid|remaining_debt|paid_amount|balance)\}/.test(text))throw new AppError('Для финансовых полей этого бланка нужен доступ к платежам',403);
 if(kind==='CONTRACT'){
  if(!['company_name','director_name','director_authority'].every(k=>text.includes(`{${k}}`)))throw new AppError('Бланк договора должен содержать переменные компании, директора и основания полномочий',409);
 }
 const rendered=renderTemplate(buffer,documentContext(data));
 await authorizeDocument(actor,project,deal); // Check revocation after template retrieval/rendering.
 return {buffer:rendered,type:MIME,name:`TOZON-${kind}-${deal}-${language}.docx`};
}
const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function printableCard(data){
 const {deal:d,client:c,unit:u,signer:s}=data;
 const rows=(data.schedules||[]).map((r,i)=>`<tr><td>${i+1}</td><td>${esc(day(r.due_date))}</td><td>${esc(money(r.amount_minor))}</td><td>${esc(money(r.paid_amount_minor))}</td></tr>`).join('');
 return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Карточка договора ${esc(d.contract_number||d.id)}</title><style>@page{size:A4;margin:16mm}body{font:14px Arial,sans-serif;color:#172033;max-width:900px;margin:24px auto;padding:12px}h1{font-size:24px}p{line-height:1.5}table{width:100%;border-collapse:collapse;margin-top:18px}td,th{border:1px solid #bbb;padding:8px;text-align:left}thead{display:table-header-group}tr{break-inside:avoid}.note{color:#64748b;font-size:12px}@media print{body{margin:0;padding:0}}</style></head><body><h1>Карточка договора № ${esc(d.contract_number||d.id)}</h1><p class="note">${d.status==='SIGNED'?'Подписанный договор':d.status==='CANCELLED'?'ОТМЕНЁН / РАСТОРГНУТ':'ЧЕРНОВИК'}. Карточка учётных данных. Полный текст договора печатается из утверждённого бланка.</p>${data.closure?`<p><strong>${data.closure.kind==='CANCEL_DRAFT'?'Черновик отменён':'Договор расторгнут'}</strong><br>Причина: ${esc(data.closure.reason)}${data.closure.basis?`<br>Основание: ${esc(data.closure.basis)} от ${esc(day(data.closure.basis_date))}`:''}</p>`:''}<p>${esc(u.project_name)}, ${esc(u.building_name)}, помещение № ${esc(u.unit_number)} · ${esc(Number(u.area_m2_x100)/100)} м²</p><p>Покупатель: <strong>${esc(c.full_name)}</strong><br>Телефон: ${esc(c.phone)}</p><p>${esc(s?.company_name)}<br>Директор: ${esc(s?.director_name)}<br>Основание полномочий: ${esc(s?.director_authority)}</p><p>Дата договора: ${esc(day(d.deal_date))}<br>Стоимость: <strong>${esc(money(d.final_price_minor))} ${esc(d.currency)}</strong><br>Первоначальный взнос (план): ${esc(money(d.down_payment_minor))} ${esc(d.currency)}</p>${data.financial?`<h2>График платежей (${esc(d.currency)})</h2><p class="note">График остатка после планового первоначального взноса. Фактическая оплата взноса оформляется отдельным ПКО.</p>${rows?`<table><thead><tr><th>№</th><th>Дата</th><th>План</th><th>Оплачено</th></tr></thead><tbody>${rows}</tbody></table>`:'<p>Ежемесячных платежей нет.</p>'}`:''}</body></html>`;
}
async function privateStorage(create=false){
 const storage=getServiceDB().storage;let {data,error}=await storage.getBucket(PRIVATE_BUCKET);
 if(error&&create&&String(error.status||error.statusCode)==='404'){
  const created=await storage.createBucket(PRIVATE_BUCKET,{public:false,fileSizeLimit:FILE_LIMIT,allowedMimeTypes:['application/pdf','image/jpeg','image/png']});
  if(created.error&&String(created.error.status||created.error.statusCode)!=='409')throw created.error;
  ({data,error}=await storage.getBucket(PRIVATE_BUCKET));
 }
 if(error)throw error;if(!data||data.public!==false)throw new AppError('Защищённое хранилище недоступно: проверьте настройки доступа',503);
 return storage.from(PRIVATE_BUCKET);
}
export function validateAttachment(file){
 const buffer=file?.buffer;if(!buffer?.length||buffer.length>FILE_LIMIT)throw new AppError('Загрузите PDF, JPEG или PNG до 10 МБ',400);
 let name=String(file.originalname||'').normalize('NFC');
 if([...name].every(c=>c.charCodeAt(0)<=255)){const utf8=Buffer.from(name,'latin1').toString('utf8');if(!utf8.includes('\uFFFD'))name=utf8;}
 if(!name||name.length>200||/[\x00-\x1f\x7f/\\]/.test(name))throw new AppError('Недопустимое имя файла',400);
 const type=buffer.subarray(0,5).toString()==='%PDF-'?'application/pdf':buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':buffer[0]===255&&buffer[1]===216&&buffer[2]===255?'image/jpeg':null;
 const extension={ 'application/pdf':/\.pdf$/i,'image/png':/\.png$/i,'image/jpeg':/\.jpe?g$/i }[type];
 if(!type||!extension.test(name))throw new AppError('Тип содержимого не соответствует PDF/JPEG/PNG',400);
 return {name,type,size:buffer.length,hash:digest(buffer)};
}
export async function uploadFile(actor,project,deal,id,file){
 const f=validateAttachment(file);await authorizeDocument(actor,project,deal,true);
 let existing;
 try{existing=await readFiles(actor,project,deal,id);}catch(e){if(e.statusCode!==404)throw e;}
 const register=()=>rpc('register_company_project_file',{...args(actor,project,deal),p_id:id,p_name:f.name,p_type:f.type,p_size:f.size,p_hash:f.hash});
 if(existing)return register();
 const store=await privateStorage(true),path=`${project}/${deal}/${id}`;
 const {error}=await store.upload(path,file.buffer,{contentType:f.type,upsert:false,cacheControl:'0'});
 if(error){
  // Another same-key request may be between storage upload and DB registration.
  // Keep the key and retry; never overwrite or delete the competing object.
  if(['409','400'].includes(String(error.statusCode||error.status))&&/duplicate|already exists/i.test(error.message||'')){
   const prior=await store.download(path);if(prior.error)throw prior.error;
   if(prior.data.size!==f.size||digest(Buffer.from(await prior.data.arrayBuffer()))!==f.hash)throw new AppError('Ключ загрузки занят другим файлом',409);
   return register();
  }
  throw error;
 }
 // Do not delete on an uncertain registration response: it may have committed.
 // Unregistered objects are inaccessible, and the same key can safely reconcile.
 return register();
}
export async function downloadFile(actor,project,deal,id){
 const f=await readFiles(actor,project,deal,id);
 if(f.object_path!==`${project}/${deal}/${id}`||!['application/pdf','image/jpeg','image/png'].includes(f.content_type)||f.file_size<1||f.file_size>FILE_LIMIT)throw new AppError('Некорректные сведения вложения',409);
 const store=await privateStorage();const {data,error}=await store.download(f.object_path);if(error)throw error;
 if(data.size!==f.file_size)throw new AppError('Размер файла не совпадает с реестром',409);
 const buffer=Buffer.from(await data.arrayBuffer());
 if(buffer.length!==f.file_size||digest(buffer)!==f.sha256)throw new AppError('Проверка целостности файла не пройдена',409);
 await authorizeDocument(actor,project,deal);
 return {buffer,type:f.content_type,name:f.original_name,metadata:meta(f)};
}
