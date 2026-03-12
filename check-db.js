require('dotenv').config();
const { Client } = require('pg');

async function checkAllDatabases() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('Connected to:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'));

    // List all databases on the server
    const dbResult = await client.query(`
      SELECT datname FROM pg_database
      WHERE datistemplate = false
      ORDER BY datname
    `);
    console.log('\n📁 Available databases:');
    dbResult.rows.forEach(row => console.log(`  - ${row.datname}`));

    // Check tables in current database (postgres)
    console.log('\n📋 Tables in "postgres" database:');
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    if (tables.rows.length === 0) {
      console.log('  (empty)');
    } else {
      tables.rows.forEach(row => console.log(`  - ${row.table_name}`));
    }

    // Try checking other common database names
    for (const row of dbResult.rows) {
      if (row.datname !== 'postgres') {
        try {
          const checkClient = new Client({
            connectionString: process.env.DATABASE_URL.replace(/\/[^\/]*$/, '/' + row.datname),
          });
          await checkClient.connect();
          const tblResult = await checkClient.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
          `);
          if (tblResult.rows.length > 0) {
            console.log(`\n📋 Tables in "${row.datname}" database:`);
            tblResult.rows.forEach(r => console.log(`  - ${r.table_name}`));
          }
          await checkClient.end();
        } catch (e) {
          // Skip databases we can't access
        }
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

checkAllDatabases();
