// backend/db.js
const { Pool } = require('pg');

// pg sẽ tự động đọc các thông tin kết nối từ biến môi trường DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Nếu deploy trên Render, cần có ssl
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Hàm khởi tạo, tự động tạo bảng nếu chưa có
const initializeDb = async () => {
  const client = await pool.connect();
  try {
    // Tạo bảng users để lưu email và profile
    // Dùng kiểu dữ liệu JSONB để lưu profile một cách linh hoạt
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        user_profile JSONB
      );
    `);
    
    // Tạo bảng symptoms để lưu các lần ghi nhận triệu chứng
    // Có một khóa ngoại (foreign key) trỏ đến bảng users
    await client.query(`
      CREATE TABLE IF NOT EXISTS symptoms (
        id TEXT PRIMARY KEY,
        user_email TEXT REFERENCES users(email) ON DELETE CASCADE,
        log_data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    console.log('Database tables are ready.');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    client.release();
  }
};

module.exports = {
  // Xuất ra một hàm query để các file khác có thể sử dụng
  query: (text, params) => pool.query(text, params),
  initializeDb,
};