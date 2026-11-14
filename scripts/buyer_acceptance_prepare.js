import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Produces reviewable SQL only. It never connects to a database or sends messages.
export function prepareBuyerAcceptance(scope){
 if(!/^buyer_acceptance_[a-f0-9]{12}$/.test(scope))throw new Error('INVALID_ACCEPTANCE_SCOPE');
 const internal=`${scope}_internal`,storage=`${scope}_storage`;
 const rewrite=sql=>{
  const mapped=sql.replace(/\bpublic\./g,`${scope}.`).replace(/\bschema public\b/gi,`schema ${scope}`)
   .replace(/\bbuyer_internal\b/g,internal).replace(/\bstorage\b/g,storage)
   .replace(/set search_path\s*=\s*([^;]*?)(?=\s+as\s+\$\$)/gi,(_match,path)=>`set search_path=${path.replace(/\bpublic\b/g,scope)}`);
  if(/\bpublic\./.test(mapped)||/\bschema public\b/i.test(mapped)||/search_path\s*=\s*[^;]*?\bpublic\b\s*(?:,|as)/i.test(mapped))throw new Error('UNSCOPED_ACCEPTANCE_SQL');
  return mapped;
 };
 const fixture=readFileSync(new URL('../src/modules/buyer-portal/testing/crm-fixture.sql',import.meta.url),'utf8')
  .replace(/create role (?:anon|authenticated|service_role)(?: bypassrls)?;/g,'');
 const directory=new URL('../supabase/migrations/',import.meta.url);
 const parts=[{name:'fixture',sql:`create schema ${scope};revoke all on schema ${scope} from public,anon,authenticated;grant usage on schema ${scope} to service_role;\n${rewrite(fixture)}`},
  ...readdirSync(directory).filter(f=>f.includes('_buyer_portal_')&&f.endsWith('.sql')).sort().map(name=>({name,sql:rewrite(readFileSync(new URL(name,directory),'utf8'))}))];
 return {scope,internal,storage,parts:parts.map(p=>({...p,sha256:createHash('sha256').update(p.sql).digest('hex')})),
  cleanup:`drop schema ${scope} cascade;drop schema ${internal} cascade;drop schema ${storage} cascade;`};
}
if(process.argv[1]===fileURLToPath(import.meta.url))process.stdout.write(JSON.stringify(prepareBuyerAcceptance(process.argv[2])));
