export const TEST_PROJECT_REF = 'yaolkwbnhnacxxjpgiyu';
const protectedRefs = ['yeslzrrcwgcqfxhgbrqk','xzvtjcqwmuezxyeerkki'];
const externalSecrets = /^(PAYOM_API_TOKEN|TELEGRAM_.*TOKEN|TELEGRAM_.*SECRET|CLOUDINARY_.*|OPENAI_API_KEY|MOIZVONKI_.*|WEBHOOK_SECRET|SALES_AUTOMATION_CRON_SECRET)$/;

export function commercialRuntimeConfig(env) {
 if(env.COMMERCIAL_RUNTIME_CONFIRM !== 'ISOLATED_TEST_RUNTIME') throw new Error('COMMERCIAL_RUNTIME_CONFIRM_REQUIRED');
 if(env.SUPABASE_URL !== `https://${TEST_PROJECT_REF}.supabase.co`) throw new Error('COMMERCIAL_RUNTIME_TARGET_MISMATCH');
 const origin=env.FRONTEND_ORIGIN;
 if(!origin || !/^https:\/\/tozon-crm-commercial-test(?:-[a-z0-9]+)?\.onrender\.com$/.test(origin)) throw new Error('COMMERCIAL_FRONTEND_ORIGIN_REQUIRED');
 for(const [key,value] of Object.entries(env)) {
  if(typeof value!=='string')continue;
  if(/URL|KEY|SECRET|TOKEN|HOST/.test(key) && protectedRefs.some(ref=>value.includes(ref)))throw new Error('COMMERCIAL_PRODUCTION_REFERENCE_FORBIDDEN');
  if(value && externalSecrets.test(key))throw new Error('COMMERCIAL_EXTERNAL_INTEGRATION_DISABLED');
 }
 const serviceKey=env.SUPABASE_SERVICE_ROLE_KEY?.trim();
 const missing=[];
 if(!serviceKey)missing.push('SUPABASE_SERVICE_ROLE_KEY');
 else if(serviceKey.startsWith('eyJ')) {
  let claims;try {claims=JSON.parse(Buffer.from(serviceKey.split('.')[1],'base64url').toString());}catch{throw new Error('COMMERCIAL_INVALID_SERVER_KEY');}
  if(claims.ref!==TEST_PROJECT_REF || claims.role!=='service_role')throw new Error('COMMERCIAL_INVALID_SERVER_KEY');
 } else if(!serviceKey.startsWith('sb_secret_'))throw new Error('COMMERCIAL_INVALID_SERVER_KEY');
 if(!env.JWT_SECRET || env.JWT_SECRET.length<48)missing.push('JWT_SECRET');
 if(env.SUPABASE_KEY && env.SUPABASE_KEY!==serviceKey)throw new Error('COMMERCIAL_CONFLICTING_SERVER_KEY');
 return {projectRef:TEST_PROJECT_REF,origin,serviceKey,missing,ready:missing.length===0};
}
