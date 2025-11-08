// backend/db.js
const { Pool } = require('pg');

// pg will automatically read connection info from the DATABASE_URL environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // On Render, SSL is required for production connections
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// This function acts as a simple migration script.
// It ensures the database schema matches what the code expects.
const initializeDb = async () => {
  const client = await pool.connect();
  try {
    console.log('Connecting to database to initialize and migrate tables...');

    // Step 1: Ensure the 'users' table exists. This is for the very first run.
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        user_profile JSONB
      );
    `);

    // Step 2: Add new columns if they don't exist. This is the migration part.
    // It patches older versions of the table without causing errors.
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hash TEXT,
      ADD COLUMN IF NOT EXISTS encrypted_gemini_key TEXT;
    `);
    
    // Step 3: Ensure the 'symptoms' table exists.
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
    // Throw the error to prevent the server from starting with a broken DB connection
    throw err; 
  } finally {
    client.release();
  }
};

module.exports = {
  // Export a query function for other files to use
  query: (text, params) => pool.query(text, params),
  initializeDb,
};