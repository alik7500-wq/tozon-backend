import {describe,it,expect,vi} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import PizZip from 'pizzip';
const mock=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn()}));
vi.mock('../../db/connection.js',()=>({getServiceDB:()=>mock}));
import {documentContext,downloadTemplate} from './workspace.documents.js';
import {compileTemplate,renderTemplate} from '../document-settings/template.engine.js';
const data={deal:{id:1,status:'SIGNED',currency:'USD',payment_type:'INSTALLMENT',final_price_minor:3600000,deal_price_per_m2_minor:60025,down_payment_minor:1080000,contract_number:'TEST-001',deal_date:'2026-11-12'},client:{full_name:'Тестовый покупатель',phone:'+992000000000',passport_number:'TEST0001',passport_issued_by:'Тестовый орган',passport_issue_date:'2020-02-14',registration_address:'Тестовый адрес покупателя',inn:'000000000'},unit:{project_id:3,unit_kind:'APARTMENT',project_name:'ЖК TOZON PLAZA',project_address:'г. Худжанд',building_name:'Блок Б',section_name:'1',floor_number:3,unit_number:7,area_m2_x100:6000,rooms:2},signer:{company_name:'ООО «ТОЗОН»',director_name:'Директор из снимка',director_authority:'Доверенность из снимка'},company:{company_inn:'630019325',company_registration:'6310011648',company_address:'Адрес компании для проверки',company_account:'Тестовый счёт',director_name:'Чужой текущий директор'},financial:true,total_paid_minor:500000,schedules:[{due_date:'2026-12-12',amount_minor:1260000,paid_amount_minor:0,status:'PENDING'},{due_date:'2027-01-12',amount_minor:1260000,paid_amount_minor:0,status:'PENDING'}]};
const load=(kind,lang)=>readFileSync(new URL(`../../../resources/company-project-templates/plaza/${kind}-${lang}.docx`,import.meta.url));
describe('source-derived Plaza apartment templates',()=>{
 for(const lang of ['RU','TJ'])for(const kind of ['CONTRACT','SCHEDULE'])it(`renders ${kind} ${lang} with frozen signer and exact amounts`,()=>{
  const buffer=load(kind,lang);compileTemplate(buffer);
  const result=renderTemplate(buffer,documentContext(data,lang)),text=new PizZip(result).file('word/document.xml').asText();
  expect(text).not.toMatch(/\{[a-z_#/]+\}/);expect(text).toContain('Директор из снимка');expect(text).not.toContain('Чужой текущий директор');expect(text).toContain('Тестовый покупатель');
  if(kind==='CONTRACT'){expect(text).toContain('600,25');expect(text).toContain('25/100');expect(text).toContain('4.1.5.');expect(text).toContain('8.4.');expect(text).not.toContain('6.5.');}
  else {expect(text).toContain('12.11.2026');expect(text).toContain('12.12.2026');expect(text).toContain('12.01.2027');expect(text).toContain('10 800,00');expect(text).toContain('5 000,00');expect(text).toContain('31 000,00');}
  if(process.env.PLAZA_QA_OUTPUT){mkdirSync(process.env.PLAZA_QA_OUTPUT,{recursive:true});writeFileSync(`${process.env.PLAZA_QA_OUTPUT}/${kind}-${lang}.docx`,result);}
 });
 it('does not expose payment plan without finance permission',()=>{const c=documentContext({...data,financial:false},'TJ');expect(c.payment_plan_rows).toEqual([]);expect(c.total_paid).toBe('—');});
 it('rejects residential USD template for parking, other currency or barter',async()=>{
  const chain={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),order:vi.fn().mockReturnThis(),limit:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{file_base64:load('CONTRACT','RU').toString('base64')}})};mock.from.mockReturnValue(chain);
  for(const bad of [{...data,unit:{...data.unit,unit_kind:'PARKING'}},{...data,deal:{...data.deal,currency:'TJS'}},{...data,deal:{...data.deal,payment_type:'PARTIAL_BARTER'}}]){mock.rpc.mockResolvedValue({data:bad});await expect(downloadTemplate(3,'project',1,'CONTRACT','RU')).rejects.toMatchObject({statusCode:409});}
  mock.rpc.mockResolvedValue({data});expect((await downloadTemplate(3,'project',1,'CONTRACT','RU')).buffer.length).toBeGreaterThan(1000);
 });
 it('refuses to fill old signed contracts without frozen signer',async()=>{mock.rpc.mockResolvedValue({data:{...data,signer:null}});await expect(downloadTemplate(3,'project',1,'CONTRACT','RU')).rejects.toMatchObject({statusCode:409});});
});
