// db.js
// PostgreSQL connection pool — single instance, reused across all modules
// Uses pg (node-postgres) with connection pooling for production workloads

const { Pool } = require('pg');

// FIX P1: Guard against missing DATABASE_URL
if (!process.env.DATABASE_URL) {
    throw new Error('[db] DATABASE_URL env var missing');
}

// Pool configuration — tune based on expected concurrent workers
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Connection pool settings
    max: 20,                    // Max connections (tune: 2× worker concurrency)
    idleTimeoutMillis: 30000,  // Close idle connections after 30s
    connectionTimeoutMillis: 5000, // Fail fast if DB unreachable
    // SSL for production (Railway, Supabase, etc.)
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false
});

// Connection error handler — log but don't crash
pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
});

// Health check — call at startup
async function healthCheck() {
    try {
        const { rows } = await pool.query('SELECT NOW() as now');
        console.log('[db] Connected:', rows[0].now);
        return true;
    } catch (err) {
        console.error('[db] Health check failed:', err.message);
        return false;
    }
}

// Export pool directly — usage: db.query('SELECT...', [params])
module.exports = pool;
module.exports.healthCheck = healthCheck;