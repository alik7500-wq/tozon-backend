import {readFileSync} from 'node:fs';
import {createWriteFixture} from './workspace.write-fixture.js';
export async function createClosureFixture(){
 const fixture=await createWriteFixture();
 await fixture.db.exec(`ALTER TABLE deals ADD COLUMN cancelled_at text;ALTER TABLE deals ADD COLUMN cancellation_reason text;`);
 await fixture.db.exec('CREATE SCHEMA storage;CREATE TABLE storage.objects(id uuid,bucket_id text);ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
 await fixture.db.exec(readFileSync(new URL('../../../supabase/migrations/20261110160426_company_project_documents_private_files.sql',import.meta.url),'utf8'));
 await fixture.db.exec(readFileSync(new URL('../../../supabase/migrations/20261110180520_company_project_contract_closure.sql',import.meta.url),'utf8'));
 return fixture;
}
