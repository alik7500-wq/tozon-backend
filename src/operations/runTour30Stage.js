import { getServiceDB } from '../db/connection.js';
import { stageTour30 } from './stageTour30.js';

// A bounded operational release task, disabled unless the one-time flag is exact.
// No HTTP endpoint, no activation, no row writes, no overwrites, no other tours.
export async function runTour30StageIfEnabled() {
  if (process.env.TOZON_TOUR30_STAGE_ONCE !== 'approved-2026-10-18') return;
  if (new URL(process.env.SUPABASE_URL).hostname !== 'yeslzrrcwgcqfxhgbrqk.supabase.co') throw new Error('TOUR30_WRONG_SUPABASE_PROJECT');
  const db = getServiceDB();
  await stageTour30(db, async path => {
    const {data}=db.storage.from('panoramas-360').getPublicUrl(path);
    const response=await fetch(data.publicUrl,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('TOUR30_PUBLIC_READ_FAILED');
    return Buffer.from(await response.arrayBuffer());
  });
}
