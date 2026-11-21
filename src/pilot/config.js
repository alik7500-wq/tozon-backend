export const TEST_REF='yaolkwbnhnacxxjpgiyu';
export const PILOT_ORIGIN='https://tozon-crm-commercial-test.onrender.com';
export function pilotConfig(env){
 const fail=()=>{throw new Error('ISOLATED_PROJECT_PILOT_CONFIGURATION_REQUIRED');};
 if(env.NODE_ENV!=='production'||env.PROJECT_WORKSPACE_PILOT_CONFIRM!==TEST_REF)fail();
 let url;try{url=new URL(env.SUPABASE_URL);}catch{fail();}
 if(url.origin!==`https://${TEST_REF}.supabase.co`||url.pathname!=='/'||url.search||url.hash||url.username||url.password)fail();
 if(env.FRONTEND_ORIGIN!==PILOT_ORIGIN||!env.JWT_SECRET?.trim()||!env.SUPABASE_SERVICE_ROLE_KEY?.trim())fail();
 // Legacy JWT keys must belong to this test project. Opaque server keys are
 // accepted only by the exact test host; invalid credentials fail in Supabase.
 const key=env.SUPABASE_SERVICE_ROLE_KEY.trim();
 if(!key.startsWith('sb_secret_')){
  let claims;try{claims=JSON.parse(Buffer.from(key.split('.')[1]||'','base64url').toString());}catch{fail();}
  if(claims.ref!==TEST_REF||claims.role!=='service_role')fail();
 }
 return {origin:PILOT_ORIGIN};
}
export async function verifyPilotDatabase(db){
 const {error}=await db.from('company_projects').select('id').limit(1);
 if(error)throw new Error('ISOLATED_PROJECT_PILOT_DATABASE_NOT_READY');
}
