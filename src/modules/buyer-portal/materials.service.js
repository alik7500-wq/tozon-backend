import {createHash,randomUUID} from 'node:crypto';
import {BuyerPortalError} from './identity.service.js';
const unavailable=()=>{throw new BuyerPortalError('BUYER_MATERIAL_UNAVAILABLE',404);};
const max=20*1024*1024;
export function imageMime(b){
 if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
 if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return 'image/webp';
 return null;
}
export function safePlanUrl(path,{portalUrl=process.env.BUYER_PORTAL_URL,cloud=process.env.CLOUDINARY_CLOUD_NAME}={}){
 if(typeof path!=='string'||path.length>2000||path.includes('..')||path.includes('%')||path.includes('\\'))return unavailable();
 if(/^\/layouts\/[A-Za-z0-9_./-]+\.(png|jpe?g|webp)$/i.test(path)){
  const base=new URL(portalUrl);if(base.protocol!=='https:'||base.username||base.password) return unavailable();return new URL(path,base.origin).href;
 }
 const u=new URL(path);
 if(u.protocol!=='https:'||u.hostname!=='res.cloudinary.com'||u.port||u.username||u.password||u.search||u.hash||!cloud||!u.pathname.startsWith(`/${cloud}/image/upload/`)||/\.svg$/i.test(u.pathname))return unavailable();
 return u.href;
}
export function visibleDocuments(rows){
 const preferred=new Set(rows.filter(d=>d.isSignedOriginal&&['CONTRACT','SCHEDULE'].includes(d.kind)).map(d=>`${d.kind}:${d.language}`));
 return rows.filter(d=>d.isSignedOriginal||!preferred.has(`${d.kind}:${d.language}`));
}
export class BuyerMaterialsService{
 constructor({repo,identity,storage,fetchFn=fetch}){this.repo=repo;this.identity=identity;this.storage=storage;this.fetchFn=fetchFn;}
 async raw(tg,dealId){
  if(!/^[1-9]\d{0,9}$/.test(String(dealId))||Number(dealId)>2147483647)return unavailable();
  const r=await this.repo.materials(String(tg),dealId);if(!r)return unavailable();return r;
 }
 async manifest(tg,dealId){
  const r=await this.raw(tg,dealId);
  return {plans:[r.plan2d?{key:'PLAN_2D'}:null,r.plan3d?{key:'PLAN_3D'}:null].filter(Boolean),
   tour:r.tour?{id:r.tour.id,name:r.tour.name,panoramas:r.tour.panoramas.map(p=>({id:p.id,name:p.name,yaw:p.yaw,pitch:p.pitch,fov:p.fov,hotspots:p.hotspots}))}:null,
   documents:visibleDocuments(r.documents||[]).map(({id,title,kind,language,version,isSignedOriginal,publishedAt})=>({id,title,kind,language,version,isSignedOriginal,publishedAt}))};
 }
 locate(r,type,id){
  if(type==='PLAN_2D'&&r.plan2d)return {path:r.plan2d,source:'PLAN'};
  if(type==='PLAN_3D'&&r.plan3d)return {path:r.plan3d,source:'PLAN'};
  if(type==='PANORAMA'){
   const p=r.tour?.panoramas.find(p=>String(p.id)===String(id));if(p)return {path:p.storagePath,source:'panoramas-360'};
  }
  if(type==='DOCUMENT'){
   const d=visibleDocuments(r.documents||[]).find(d=>d.id===id);if(d)return {...d,path:d.storagePath,source:'buyer-documents'};
  }
  return unavailable();
 }
 async asset(tg,{dealId,type,id}){
  const before=this.locate(await this.raw(tg,dealId),type,id);let buffer;
  if(before.source==='PLAN'){
   const response=await this.fetchFn(safePlanUrl(before.path),{redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok||Number(response.headers.get('content-length'))>max)return unavailable();
   const reader=response.body.getReader(),parts=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();return unavailable();}parts.push(Buffer.from(value));}}finally{reader.releaseLock();}
   buffer=Buffer.concat(parts);
  }else{
   if(!/^[A-Za-z0-9_./-]+$/.test(before.path)||before.path.includes('..'))return unavailable();
   buffer=await this.storage.download(before.source,before.path);if(buffer.length>max)return unavailable();
  }
  const after=this.locate(await this.raw(tg,dealId),type,id);
  if(before.path!==after.path||before.sha256!==after.sha256)return unavailable();
  let mime=imageMime(buffer);
  if(type==='DOCUMENT'){
   if(buffer.length!==before.size||createHash('sha256').update(buffer).digest('hex')!==before.sha256)return unavailable();
   mime=before.mime==='application/pdf'&&buffer.toString('ascii',0,5)==='%PDF-'?'application/pdf':mime;
   if(mime!==before.mime)return unavailable();
  }
  if(!mime)return unavailable();return {buffer,mime,filename:type==='DOCUMENT'?`TOZON-document.${mime==='application/pdf'?'pdf':mime==='image/png'?'png':'jpg'}`:null};
 }
 async staffList(dealId,user){const deal=await this.identity.repo.deal(dealId);this.identity.assertStaff(user,deal,{allowCancelled:true});return this.repo.documentList(dealId,deal.lead_id);}
 async staffAsset(dealId,user,id){
  const deal=await this.identity.repo.deal(dealId);this.identity.assertStaff(user,deal,{allowCancelled:true});
  const doc=await this.repo.staffDocument(dealId,id,deal.lead_id);if(!doc)return unavailable();
  const buffer=await this.storage.download('buyer-documents',doc.storage_path);
  const fresh=await this.identity.repo.deal(dealId);this.identity.assertStaff(user,fresh,{allowCancelled:true});
  if(fresh.lead_id!==deal.lead_id||buffer.length!==doc.file_size||createHash('sha256').update(buffer).digest('hex')!==doc.sha256)return unavailable();
  return {buffer,mime:doc.mime_type,filename:`TOZON-document.${doc.mime_type==='application/pdf'?'pdf':doc.mime_type==='image/png'?'png':'jpg'}`};
 }
 async upload(dealId,user,fields,file){
  const deal=await this.identity.repo.deal(dealId);this.identity.assertStaff(user,deal);
  if(!file?.buffer?.length||file.buffer.length>12*1024*1024)throw new BuyerPortalError('BUYER_DOCUMENT_INVALID');
  const mime=file.buffer.toString('ascii',0,5)==='%PDF-'?'application/pdf':imageMime(file.buffer);
  if(!['application/pdf','image/png','image/jpeg'].includes(mime)||!['CONTRACT','SCHEDULE','ACT','APPENDIX','OTHER'].includes(fields.kind)||!['tj','ru'].includes(fields.language)||!fields.title?.trim()||fields.title.length>150)throw new BuyerPortalError('BUYER_DOCUMENT_INVALID');
  const id=randomUUID(),path=`deals/${deal.id}/${id}.${mime==='application/pdf'?'pdf':mime==='image/png'?'png':'jpg'}`;
  await this.storage.upload(path,file.buffer,mime);
  try{return await this.repo.createDocument({id,deal_id:deal.id,owner_lead_id:deal.lead_id,title:fields.title.trim(),kind:fields.kind,language:fields.language,
    is_signed_original:fields.isSignedOriginal==='true',version:1,storage_path:path,mime_type:mime,file_size:file.buffer.length,sha256:createHash('sha256').update(file.buffer).digest('hex'),created_by:user.id});}
  catch(e){await this.storage.remove(path).catch(()=>{});throw e;}
 }
 async publish(dealId,id,user,action){
  const deal=await this.identity.repo.deal(dealId);this.identity.assertStaff(user,deal,{allowCancelled:action==='REVOKE'});
  if(!['ADMIN','DIRECTOR'].includes(user.role))throw new BuyerPortalError('BUYER_ACCESS_DENIED',403);
  if(!['PUBLISH','REVOKE'].includes(action))throw new BuyerPortalError('BUYER_DOCUMENT_INVALID');
  return this.repo.publishDocument(dealId,id,deal.lead_id,user.id,action);
 }
}
