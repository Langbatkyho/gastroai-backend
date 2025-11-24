// backend/db.js
const { Pool } = require('pg');

// Lấy connection string từ biến môi trường
const connectionString = process.env.DATABASE_URL;

// Kiểm tra xem có đang kết nối tới database "cloud" (Render, Supabase, Neon, v.v.) không.
// Hầu hết các cloud provider đều yêu cầu SSL.
// Localhost thường không cần SSL.
const isRemoteDb = connectionString && (
  connectionString.includes('render.com') || 
  connectionString.includes('supabase.com') || 
  connectionString.includes('railway.app') ||
  connectionString.includes('neon.tech')
);

const pool = new Pool({
  connectionString: connectionString,
  // Cấu hình SSL:
  // 1. Nếu là production (trên server Render/Vercel/etc): BẮT BUỘC dùng SSL.
  // 2. Nếu là remote DB (Supabase): BẮT BUỘC dùng SSL dù đang chạy local.
  ssl: (process.env.NODE_ENV === 'production' || isRemoteDb) ? { rejectUnauthorized: false } : false,
});

// Hàm khởi tạo database (Migration script)
const initializeDb = async () => {
  const client = await pool.connect();
  try {
    console.log('Connecting to database to initialize and migrate tables...');

    // Bước 1: Tạo bảng users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        user_profile JSONB
      );
    `);

    // Bước 2: Thêm cột mới (Migration)
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hash TEXT,
      ADD COLUMN IF NOT EXISTS encrypted_gemini_key TEXT;
    `);
    
    // Bước 3: Tạo bảng symptoms
    await client.query(`
      CREATE TABLE IF NOT EXISTS symptoms (
        id TEXT PRIMARY KEY,
        user_email TEXT REFERENCES users(email) ON DELETE CASCADE,
        log_data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    console.log('Database schema is up to date.');

  } catch (err) {
    console.error('Error during database initialization/migration:', err);
    throw err; 
  } finally {
    client.release();
  }
};

module.exports = {
  query: (text, params) => pool.query(text, params),
  initializeDb,
};