require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

async function testConnection() {
  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('✅ Connected successfully!');

    // Test query
    const result = await client.query('SELECT version()');
    console.log('PostgreSQL version:', result.rows[0].version);

    // List all tables
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    console.log('\n📋 Existing tables:');
    if (tables.rows.length === 0) {
      console.log('  (No tables found)');
    } else {
      tables.rows.forEach(row => console.log(`  - ${row.table_name}`));
    }

  } catch (error) {
    console.error('❌ Connection failed:', error.message);
  } finally {
    await client.end();
    console.log('\nConnection closed.');
  }
}

testConnection();
