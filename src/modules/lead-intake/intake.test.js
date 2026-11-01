import { beforeEach, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { normalizePhone, prepareRows, digest } from './intake.validation.js';
import { readIntakeFile, parseCsv } from './intake.files.js';
const mocks=vi.hoisted(()=>({db:{from:vi.fn(),rpc:vi.fn()}}));
vi.mock('../../db/connection.js',()=>({getServiceDB:()=>mocks.db}));
vi.mock('../../middleware/auth.middleware.js',()=>({protect:(req,res,next)=>{if(!req.headers['x-test-role'])return res.status(401).end();req.user={id:1,role:req.headers['x-test-role']};next()}}));
import router from './intake.router.js';
import { previewImport, commitImport } from './intake.service.js';
const app=express();app.use(express.json());app.use('/api/leads/intake',router);app.use((err,req,res,next)=>res.status(err.statusCode||500).json({message:err.message}));
const settings={source:'WEBINAR',campaign:'Launch',project_id:null,manager_id:null};
beforeEach(()=>{vi.clearAllMocks();process.env.JWT_SECRET='test-only-preview-secret';});
it('normalizes Tajik and international numbers without accepting malformed data',()=>{
 expect(normalizePhone('900 123-456')).toBe('+992900123456');expect(normalizePhone('00992 (900) 123456')).toBe('+992900123456');expect(normalizePhone('+7 999 123 45 67')).toBe('+79991234567');expect(normalizePhone('abc900123456')).toBeNull();
 const rows=prepareRows([{full_name:'',phone:'900123456'},{full_name:'Valid',phone:'+992900123456'},{full_name:'Again',phone:'900123456'}]);expect(rows[0].errors).toHaveLength(1);expect(rows[1].repeated).toBe(false);expect(rows[2].repeated).toBe(true);
});
it('reads UTF-8 CSV with quoted separators, escaped quotes and newlines',()=>{
 expect(parseCsv('\uFEFFИмя;Телефон;Заметка\r\n"А; Б";900123456;"Заметка\nстрока ""2"""')).toEqual([['Имя','Телефон','Заметка'],['А; Б','900123456','Заметка\nстрока "2"']]);
 expect(()=>parseCsv('Имя;Телефон\n"abc;123')).toThrow('Незакрытые');
});
it('reads XLSX numbers as contact text and rejects formula cells',async()=>{
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Leads');ws.addRows([['ФИО','Телефон'],['Name',992900123456]]);
 const file={originalname:'leads.xlsx',buffer:Buffer.from(await wb.xlsx.writeBuffer())};expect((await readIntakeFile(file))[0].rows[0][1]).toBe('992900123456');
 ws.getCell('B2').value={formula:'1+1',result:2};file.buffer=Buffer.from(await wb.xlsx.writeBuffer());await expect(readIntakeFile(file)).rejects.toThrow('формулы');
});
it('preview classifies repeats/errors without writes and signs contents for that actor',async()=>{
 mocks.db.rpc.mockResolvedValue({data:[{id:7,phone:'992900123456',full_name:'Existing',archived:false}],error:null});
 const p=await previewImport({settings,rows:[{full_name:'New',phone:'900123456'},{full_name:'Invalid',phone:'bad'}]},{id:1});
 expect(p.rows.map(r=>r.outcome)).toEqual(['REPEAT','INVALID']);expect(mocks.db.rpc).toHaveBeenCalledWith('crm_intake_matches',expect.anything());
 await expect(commitImport({...p,payload:{...p.payload,settings:{...settings,campaign:'altered'}}},{id:1})).rejects.toThrow('изменились');
 await expect(commitImport(p,{id:2})).rejects.toThrow('изменились');
 await expect(commitImport({...p,expires:1},{id:1})).rejects.toThrow('истёк');
 mocks.db.rpc.mockResolvedValue({data:{outcome:'CREATED',lead_id:9},error:null});const c=await commitImport(p,{id:1});expect(c.results.map(r=>r.outcome)).toEqual(['CREATED','INVALID']);expect(c.next_offset).toBeNull();
});
it('manager and unauthenticated requests cannot import or configure sources',async()=>{
 expect((await request(app).post('/api/leads/intake/preview').send({})).status).toBe(401);
 expect((await request(app).post('/api/leads/intake/integrations').set('x-test-role','SALES_MANAGER').send({})).status).toBe(403);
 expect(mocks.db.from).not.toHaveBeenCalled();
});
it('Google endpoint checks per-integration secret, rejects invalid data and limits input identity',async()=>{
 const config={id:'00000000-0000-4000-8000-000000000001',is_active:true,token_hash:digest('correct')};
 mocks.db.from.mockReturnValue({select:()=>({eq:()=>({maybeSingle:async()=>({data:config,error:null})})})});mocks.db.rpc.mockResolvedValue({data:{outcome:'CREATED',lead_id:88},error:null});
 const url='/api/leads/intake/google/'+config.id;
 expect((await request(app).post(url).set('x-lead-intake-key','bad').send({})).status).toBe(401);
 expect((await request(app).post(url).set('x-lead-intake-key','correct').send({full_name:'Name',phone:'invalid',external_key:'a'})).status).toBe(422);
 const r=await request(app).post(url).set('x-lead-intake-key','correct').send({full_name:'Name',phone:'900123456',external_key:'a',responsible_user_id:999,source:'FORGED'});
 expect(r.status).toBe(200);expect(mocks.db.rpc).toHaveBeenCalledWith('crm_intake_lead',expect.objectContaining({p_settings:{},p_actor:null,p_integration:config.id,p_lead:{full_name:'Name',phone:'+992900123456',notes:'',submitted_at:''}}));
 config.is_active=false;expect((await request(app).post(url).set('x-lead-intake-key','correct').send({})).status).toBe(401);
});
