import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runMigrations = () => {
  const db = connectDB();
  
  // Create migrations table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      executed_at TEXT NOT NULL
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const isExecuted = db.prepare('SELECT id FROM migrations WHERE name = ?').get(file);
    
    if (!isExecuted) {
      console.log(`Running migration: ${file}`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      
      const transaction = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO migrations (name, executed_at) VALUES (?, ?)').run(file, new Date().toISOString());
      });

      try {
        transaction();
        console.log(`Migration ${file} applied successfully.`);
      } catch (error) {
        console.error(`Error applying migration ${file}:`, error);
        process.exit(1);
      }
    } else {
      console.log(`Skipping migration ${file} (already executed).`);
    }
  }

  console.log('All migrations applied.');
};

runMigrations();
