// Static dependency inventory only. Never imports the application or opens a DB.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { commercialCoreSchema } from '../../src/db/commercial-core-schema.js';
import { commercialExtendedSchema, commercialExtendedFunctions } from '../../src/db/commercial-extended-schema.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
function files(dir) {
 return readdirSync(dir,{withFileTypes:true}).flatMap(e=> e.isDirectory() ? files(join(dir,e.name)) : e.name.endsWith('.js') && !e.name.endsWith('.test.js') ? [join(dir,e.name)] : []);
}
const installed = [...new Set([...`${commercialCoreSchema}\n${commercialExtendedSchema}`.matchAll(/CREATE TABLE "?public"?\."?(\w+)"?/g)].map(m=>m[1]))];
const installedRpcs = [...new Set([...commercialExtendedFunctions.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map(m=>m[1]))];
const tables=new Map(), rpcs=new Map();
for(const file of files(join(root,'src/modules'))) {
 const source=readFileSync(file,'utf8');
 for (const [pattern,map] of [[/\.from\(\s*['"]([a-z_][a-z_0-9]*)['"]\s*\)/g,tables],[/\.rpc\(\s*['"]([a-z_][a-z_0-9]*)['"]/g,rpcs]]) {
  for(const m of source.matchAll(pattern)) {
   const paths=map.get(m[1])||new Set();paths.add(relative(root,file));map.set(m[1],paths);
  }
 }
}
const inventory=map=>[...map].sort(([a],[b])=>a.localeCompare(b)).map(([name,paths])=>({name,sources:[...paths].sort()}));
console.log(JSON.stringify({
 scope:'Static literal references in src/modules only; dynamic names, storage APIs, views and external dependencies require manual review.',
 crmReady:false,
 installedTables:installed.sort(),
 missingTableCandidates:inventory(tables).filter(x=>!installed.includes(x.name)),
 requiredRpcCandidates:inventory(rpcs),
 missingRpcCandidates:inventory(rpcs).filter(x=>!installedRpcs.includes(x.name)),
 optionalUnreleasedTables: ['tour360_publish_jobs'],
},null,2));
