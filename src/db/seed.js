import bcrypt from 'bcrypt';
import { connectDB } from './connection.js';

const seed = async () => {
  const db = connectDB();
  
  // Create an Admin user
  const passwordHash = await bcrypt.hash('admin123', 10);
  const now = new Date().toISOString();

  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@tozon.crm');
    if (!existing) {
      insertUser.run('Super Admin', 'admin@tozon.crm', passwordHash, 'ADMIN', now, now);
      console.log('Admin user created successfully! (email: admin@tozon.crm, password: admin123)');
    } else {
      console.log('Admin user already exists.');
    }
  } catch (error) {
    console.error('Failed to seed DB:', error);
  }
};

seed();
