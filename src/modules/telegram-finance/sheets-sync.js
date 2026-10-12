import crypto from 'node:crypto';
export const cashSheets = {
  'ab90800a-73af-4cf7-88c2-397c304e2edf': 'Касса Акмалхон',
  '6ddf2f64-0a77-4aeb-8daf-a391b2da0141': 'Касса Илхомчон',
};
export const sheetSyncConfigured = () => Boolean(process.env.TOZON_SHEETS_WEBHOOK_URL && process.env.TOZON_SHEETS_SECRET?.length >= 32);
export async function syncSheets(repo, fetchImpl=fetch) {
  if(!sheetSyncConfigured())return;
  const url=process.env.TOZON_SHEETS_WEBHOOK_URL;
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url))throw new Error('INVALID_SHEETS_ENDPOINT');
  const rows=await repo.sheetJobs();
  for(const job of rows.slice(0,1)) {
    const sheet=cashSheets[job.cash_desk_id];
    if(!sheet){await repo.finishSheetJob(job.id,'UNMAPPED');continue;}
    const payload=JSON.stringify({id:job.id,sheet,...job.payload});
    const timestamp=Date.now();
    const signature=crypto.createHmac('sha256',process.env.TOZON_SHEETS_SECRET).update(timestamp+'.'+payload).digest('hex');
    try {
      const res=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload,timestamp,signature}),signal:AbortSignal.timeout(20000)});
      const result=await res.json();
      if(!res.ok||result.ok!==true||result.id!==job.id)throw new Error('SHEETS_ACK_MISMATCH');
      await repo.finishSheetJob(job.id,'SENT');
    } catch {await repo.retrySheetJob(job.id,job.attempts+1);}
  }
}
