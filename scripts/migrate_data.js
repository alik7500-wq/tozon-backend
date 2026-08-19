import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const sqlite = new Database(path.resolve(__dirname, '../../data/app.db'));

async function migrateTable(tableName, orderBy = 'id ASC') {
  console.log(`Migrating ${tableName}...`);
  let rows;
  try {
    rows = sqlite.prepare(`SELECT * FROM ${tableName} ORDER BY ${orderBy}`).all();
  } catch (err) {
    console.log(`Skipping ${tableName}: ${err.message}`);
    return;
  }
  
  if (rows.length === 0) {
    console.log(`No data in ${tableName}.`);
    return;
  }

  const batchSize = 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    
    const { error } = await supabase.from(tableName).upsert(batch, { onConflict: 'id' });
    
    if (error) {
      console.error(`Error migrating ${tableName}:`, error);
      throw error;
    }
  }
  console.log(`Migrated ${rows.length} rows for ${tableName}.`);
}

async function run() {
  try {
    await migrateTable('leads');
    await migrateTable('lead_notes');
    await migrateTable('deals');
    await migrateTable('deal_payment_schedules');
    await migrateTable('deal_documents');
    await migrateTable('payments');
    
    console.log('Migration complete for CRM entities!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    sqlite.close();
  }
}

run();
