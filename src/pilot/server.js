import 'dotenv/config';
import {pilotConfig,verifyPilotDatabase} from './config.js';
pilotConfig(process.env); // Validate before any database/client imports.
// Server-only auth uses the same private test client as scoped operations.
process.env.SUPABASE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const {connectDB,getServiceDB}=await import('../db/connection.js');
const {createPilotApp}=await import('./app.js');
connectDB();
await verifyPilotDatabase(getServiceDB());
const port=Number(process.env.PORT||3000);
const server=createPilotApp().listen(port,'0.0.0.0',()=>console.log('Isolated project pilot listening'));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>process.exit(0)));
