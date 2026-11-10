import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
const mock=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),getBucket:vi.fn(),createBucket:vi.fn(),storageFrom:vi.fn(),upload:vi.fn(),download:vi.fn()}));
vi.mock('../../db/connection.js',()=>({getServiceDB:()=>({rpc:mock.rpc,from:mock.from,storage:{getBucket:mock.getBucket,createBucket:mock.createBucket,from:mock.storageFrom}})}));
import {downloadFile,uploadFile,validateAttachment,printableCard,downloadTemplate,documentContext} from './workspace.documents.js';
import {sampleTemplate} from '../document-settings/template.engine.js';
import PizZip from 'pizzip';
const project='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000003';
const buffer=Buffer.from('%PDF-1.7\nTEST\n%%EOF'),hash=createHash('sha256').update(buffer).digest('hex');
const file={id,object_path:`${project}/1/${id}`,original_name:'contract.pdf',content_type:'application/pdf',file_size:buffer.length,sha256:hash};
const doc={deal:{id:1,status:'SIGNED',currency:'USD',final_price_minor:10000,down_payment_minor:0,contract_number:'A-1',deal_date:'2026-11-10'},client:{full_name:'Buyer',passport_number:'own-passport'},unit:{project_id:1,project_name:'Plaza',area_m2_x100:6000},signer:{company_name:'TOZON',director_name:'Frozen director',director_authority:'Frozen authority'},company:{director_name:'Wrong global director'},financial:true,schedules:[]};
beforeEach(()=>{
 vi.resetAllMocks();mock.rpc.mockImplementation((name)=>Promise.resolve(name==='read_company_project_files'?{data:file}:name==='read_company_project_document'?{data:structuredClone(doc)}:{data:{id}}));
 mock.getBucket.mockResolvedValue({data:{public:false}});mock.storageFrom.mockReturnValue({upload:mock.upload,download:mock.download});mock.upload.mockResolvedValue({data:{}});mock.download.mockResolvedValue({data:new Blob([buffer])});
});
describe('document service and private storage',()=>{
 it('rejects executable, mislabeled and traversal filenames before upload',()=>{
  for(const f of [{buffer:Buffer.from('<svg/>'),originalname:'photo.png'},{buffer,originalname:'contract.html'},{buffer,originalname:'../contract.pdf'},{buffer,originalname:'bad\n.pdf'}])expect(()=>validateAttachment(f)).toThrow();
  expect(validateAttachment({buffer,originalname:'contract.pdf'}).type).toBe('application/pdf');
 });
 it('authorizes a download before reading storage and verifies integrity and revocation afterwards',async()=>{
  const result=await downloadFile(10,project,1,id);expect(result.buffer.equals(buffer)).toBe(true);expect(mock.download).toHaveBeenCalledWith(file.object_path);expect(mock.rpc.mock.calls.at(-1)[0]).toBe('authorize_company_project_document');
  mock.rpc.mockResolvedValue({error:{code:'42501'}});await expect(downloadFile(10,project,1,id)).rejects.toMatchObject({statusCode:403});expect(mock.download).toHaveBeenCalledTimes(1);
 });
 it('refuses public bucket drift, forged object paths and corrupted content',async()=>{
  mock.getBucket.mockResolvedValue({data:{public:true}});await expect(downloadFile(10,project,1,id)).rejects.toMatchObject({statusCode:503});expect(mock.download).not.toHaveBeenCalled();
  mock.getBucket.mockResolvedValue({data:{public:false}});mock.rpc.mockResolvedValue({data:{...file,object_path:'foreign/secret'}});await expect(downloadFile(10,project,1,id)).rejects.toMatchObject({statusCode:409});
  mock.rpc.mockImplementation(name=>Promise.resolve({data:name==='read_company_project_files'?{...file,sha256:'b'.repeat(64)}:{}}));await expect(downloadFile(10,project,1,id)).rejects.toMatchObject({statusCode:409});
 });
 it('does not overwrite an object or upload again after registration; rejects changed retry metadata in SQL',async()=>{
  await uploadFile(10,project,1,id,{buffer,originalname:'contract.pdf'});expect(mock.upload).not.toHaveBeenCalled();expect(mock.rpc.mock.calls.at(-1)).toEqual(['register_company_project_file',expect.objectContaining({p_id:id,p_hash:hash})]);
 });
 it('creates a private size-limited bucket on the first authorized upload and never uses upsert',async()=>{
  mock.rpc.mockImplementation(name=>Promise.resolve(name==='read_company_project_files'?{error:{code:'P0002'}}:{data:{id}}));mock.getBucket.mockResolvedValueOnce({error:{status:404}}).mockResolvedValueOnce({data:{public:false}});mock.createBucket.mockResolvedValue({data:{}});
  await uploadFile(10,project,1,id,{buffer,originalname:'contract.pdf'});
  expect(mock.createBucket).toHaveBeenCalledWith('company-project-private',expect.objectContaining({public:false,fileSizeLimit:10485760}));expect(mock.upload).toHaveBeenCalledWith(file.object_path,buffer,expect.objectContaining({upsert:false,contentType:'application/pdf'}));
 });
 it('reconciles an uploaded object after an uncertain registration response with the same key',async()=>{
  mock.rpc.mockImplementation(name=>Promise.resolve(name==='read_company_project_files'?{error:{code:'P0002'}}:{data:{id}}));mock.upload.mockResolvedValue({error:{statusCode:'409',message:'The resource already exists'}});
  await uploadFile(10,project,1,id,{buffer,originalname:'contract.pdf'});expect(mock.upload.mock.calls[0][2].upsert).toBe(false);expect(mock.download).toHaveBeenCalledWith(file.object_path);expect(mock.rpc.mock.calls.at(-1)[0]).toBe('register_company_project_file');
 });
 it('does not register mismatched duplicate bytes or delete an object after an uncertain commit',async()=>{
  mock.rpc.mockImplementation(name=>Promise.resolve(name==='read_company_project_files'?{error:{code:'P0002'}}:{data:{id}}));mock.upload.mockResolvedValue({error:{statusCode:'409',message:'Duplicate'}});mock.download.mockResolvedValue({data:new Blob(['different'])});await expect(uploadFile(10,project,1,id,{buffer,originalname:'contract.pdf'})).rejects.toMatchObject({statusCode:409});expect(mock.rpc.mock.calls.some(([name])=>name==='register_company_project_file')).toBe(false);
 });
 it('uses canonical frozen director values and escapes data in printable HTML',()=>{
  const d=structuredClone(doc);d.client.full_name='<img src=x onerror=alert(1)>';expect(documentContext(d).director_name).toBe('Frozen director');
  const html=printableCard(d);expect(html).toContain('&lt;img');expect(html).not.toContain('<img');expect(html).toContain("default-src 'none'");expect(html).not.toContain('own-passport');
 });
 it('chooses only the own-complex or global template and fills authority from the snapshot',async()=>{
  const chain={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),order:vi.fn().mockReturnThis(),limit:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{file_base64:sampleTemplate('CONTRACT').toString('base64')}})};mock.from.mockReturnValue(chain);
  const r=await downloadTemplate(10,project,1,'CONTRACT','RU');expect(chain.eq).toHaveBeenCalledWith('scope','1');const text=new PizZip(r.buffer).file('word/document.xml').asText();expect(text).toContain('Frozen director');expect(text).toContain('Frozen authority');expect(text).not.toContain('Wrong global director');
  mock.rpc.mockResolvedValue({data:{...doc,financial:false}});await expect(downloadTemplate(10,project,1,'SCHEDULE','RU')).rejects.toMatchObject({statusCode:403});
 });
});
