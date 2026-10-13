import crypto from 'node:crypto';
let lastResult=null;
export const cashSheets = {
  'ab90800a-73af-4cf7-88c2-397c304e2edf': 'Касса Акмалхон',
  '6ddf2f64-0a77-4aeb-8daf-a391b2da0141': 'Касса Илхомчон',
};
export function sheetConfiguration() {
 const url=process.env.TOZON_SHEETS_WEBHOOK_URL?.trim()||'';
 return {last_result:lastResult,url_present:Boolean(url),url_valid:/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url),secret_present:Boolean(process.env.TOZON_SHEETS_SECRET),secret_valid:Boolean(process.env.TOZON_SHEETS_SECRET?.length>=32)};
}
export const sheetSyncConfigured = () => { const c=sheetConfiguration(); return c.url_valid&&c.secret_valid; };
export async function syncSheets(repo, fetchImpl=fetch) {
  if(!sheetSyncConfigured())return;
  const url=process.env.TOZON_SHEETS_WEBHOOK_URL.trim();
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url))throw new Error('INVALID_SHEETS_ENDPOINT');
  const rows=await repo.sheetJobs();
  for(const job of rows.slice(0,1)) {
    const sheet=cashSheets[job.cash_desk_id];
    if(!sheet){await repo.finishSheetJob(job.id,'UNMAPPED');continue;}
    const payload=JSON.stringify({id:job.id,sheet,...job.payload});
    const timestamp=Date.now();
    const signature=crypto.createHmac('sha256',process.env.TOZON_SHEETS_SECRET).update(timestamp+'.'+payload).digest('hex');
    try {
      const res=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload,timestamp,signature}),signal:AbortSignal.timeout(45000)});
      if(!res.ok)throw new Error('GOOGLE_HTTP_ERROR');
      let result;try {result=await res.json();}catch {throw new Error('GOOGLE_NON_JSON_RESPONSE');}
      if(result.ok===false)throw new Error(result.error==='SYNC_FAILED'?'GOOGLE_SCRIPT_FAILED':'GOOGLE_REJECTED_SIGNATURE_OR_PAYLOAD');
      if(result.ok!==true||result.id!==job.id)throw new Error('SHEETS_ACK_MISMATCH');
      await repo.finishSheetJob(job.id,'SENT');lastResult='SENT';
    } catch(e) {lastResult=['GOOGLE_HTTP_ERROR','GOOGLE_NON_JSON_RESPONSE','GOOGLE_SCRIPT_FAILED','GOOGLE_REJECTED_SIGNATURE_OR_PAYLOAD','SHEETS_ACK_MISMATCH'].includes(e.message)?e.message:e.name==='TimeoutError'?'GOOGLE_TIMEOUT':'GOOGLE_NETWORK_OR_QUEUE_ERROR';await repo.retrySheetJob(job.id,job.attempts+1);}
  }
}
