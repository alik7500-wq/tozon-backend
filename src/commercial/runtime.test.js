import {expect,it} from 'vitest';
import request from 'supertest';
import {commercialRuntimeConfig} from './runtime-config.js';
import {buildCommercialServer} from './server.js';
const env={COMMERCIAL_RUNTIME_CONFIRM:'ISOLATED_TEST_RUNTIME',SUPABASE_URL:'https://yaolkwbnhnacxxjpgiyu.supabase.co',FRONTEND_ORIGIN:'https://tozon-crm-commercial-test.onrender.com'};
it('serves setup health while refusing business routes without keys',async()=>{
 const app=await buildCommercialServer(env);
 const health=await request(app).get('/api/health');
 expect(health.status).toBe(200);expect(health.body.crmReady).toBe(false);expect(health.body.missing).toContain('SUPABASE_SERVICE_ROLE_KEY');
 expect((await request(app).post('/api/auth/login').send({email:'x',password:'x'})).status).toBe(503);
 expect((await request(app).get('/api/health').set('Origin','https://tozon-crm.onrender.com')).status).toBe(403);
});
it('refuses production targets, external credentials and wrong JWT project roles',()=>{
 expect(()=>commercialRuntimeConfig({...env,SUPABASE_URL:'https://yeslzrrcwgcqfxhgbrqk.supabase.co'})).toThrow('TARGET_MISMATCH');
 expect(()=>commercialRuntimeConfig({...env,PAYOM_API_TOKEN:'example'})).toThrow('INTEGRATION_DISABLED');
 const key='eyJ.'+Buffer.from(JSON.stringify({ref:'yeslzrrcwgcqfxhgbrqk',role:'service_role'})).toString('base64url')+'.test';
 expect(()=>commercialRuntimeConfig({...env,SUPABASE_SERVICE_ROLE_KEY:key})).toThrow('INVALID_SERVER_KEY');
 expect(()=>commercialRuntimeConfig({...env,SUPABASE_SERVICE_ROLE_KEY:'sb_publishable_example'})).toThrow('INVALID_SERVER_KEY');
});
it('accepts test-only server keys and a separate JWT secret without leaking values',()=>{
 const key='sb_secret_example';const jwt='x'.repeat(64);
 expect(commercialRuntimeConfig({...env,SUPABASE_SERVICE_ROLE_KEY:key,JWT_SECRET:jwt}).ready).toBe(true);
});
