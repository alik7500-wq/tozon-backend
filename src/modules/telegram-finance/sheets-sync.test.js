import {it,expect,vi,afterEach} from 'vitest';
import crypto from 'node:crypto';
import {syncSheets} from './sheets-sync.js';
afterEach(()=>vi.unstubAllEnvs());
const job={id:'11111111-1111-4111-8111-111111111111',cash_desk_id:'ab90800a-73af-4cf7-88c2-397c304e2edf',payload:{amount_minor:100,currency:'USD'},attempts:0};
const repo=()=>({sheetJobs:vi.fn(async()=>[job]),finishSheetJob:vi.fn(),retrySheetJob:vi.fn()});
function config(){vi.stubEnv('TOZON_SHEETS_WEBHOOK_URL','https://script.google.com/macros/s/TEST/exec');vi.stubEnv('TOZON_SHEETS_SECRET','x'.repeat(32));}
it('does not send financial data before integration is configured',async()=>{vi.stubEnv('TOZON_SHEETS_WEBHOOK_URL','');const r=repo(),f=vi.fn();await syncSheets(r,f);expect(f).not.toHaveBeenCalled();expect(r.sheetJobs).not.toHaveBeenCalled();});
it('signs immutable job identity, routes exact cash desk and requires matching acknowledgement',async()=>{config();const r=repo();const f=vi.fn(async(url,options)=>{const body=JSON.parse(options.body);expect(JSON.parse(body.payload)).toMatchObject({id:job.id,sheet:'Касса Акмалхон'});expect(body.signature).toBe(crypto.createHmac('sha256','x'.repeat(32)).update(body.timestamp+'.'+body.payload).digest('hex'));return {ok:true,json:async()=>({ok:true,id:job.id})}});await syncSheets(r,f);expect(r.finishSheetJob).toHaveBeenCalledWith(job.id,'SENT');});
it('retries a lost or mismatched acknowledgement using the same durable id',async()=>{config();const r=repo();await syncSheets(r,async()=>({ok:true,json:async()=>({ok:true,id:'wrong'})}));expect(r.finishSheetJob).not.toHaveBeenCalled();expect(r.retrySheetJob).toHaveBeenCalledWith(job.id,1);});
it('does not send another desk to a default sheet',async()=>{config();const r=repo();r.sheetJobs.mockResolvedValue([{...job,cash_desk_id:'foreign'}]);const f=vi.fn();await syncSheets(r,f);expect(f).not.toHaveBeenCalled();expect(r.finishSheetJob).toHaveBeenCalledWith(job.id,'UNMAPPED');});
