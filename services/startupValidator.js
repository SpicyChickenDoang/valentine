// services/startupValidator.js — Run at boot, fail fast on any issue
const fs = require('fs');

async function validateStartup(redis) {
  const errors = [];
  const domain = process.env.TENANT_DOMAIN;
  
  // 1. Required env vars
  ['GEMINI_API_KEY', 'DATABASE_URL', 'REDIS_URL', 'TENANT_DOMAIN', 'TENANT_ID']
    .forEach(k => { if (!process.env[k]) errors.push(`Missing env: ${k}`); });
  
  // 2. Required files
  [`./prompts/${domain}_prompt.txt`, `./kb/${domain}/00_KB_ROUTER.txt`, `./kb/index.json`]
    .forEach(f => { if (!fs.existsSync(f)) errors.push(`Missing file: ${f}`); });
  
  // 3. KB manifest validation
  try {
    const router = fs.readFileSync(`./kb/${domain}/00_KB_ROUTER.txt`, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(`./kb/index.json`, 'utf8'));
    // v8.1 FIX: canonical format is { entries: [...] }, with backward-compat for bare array
    const entries = manifest.entries ?? manifest;
    const manifestIds = entries.map(e => e.id);
    // v8.1 FIX: Router uses UPPERCASE shorthand (e.g., 66_LAB_ANALYSIS_ENGINE)
    // Index uses lowercase with suffix (e.g., 66_lab_analysis_engine_monograph_v1)
    // Match logic mirrors kbRetriever.get(): prefix match OR topic substring match
    const routerIds = [...new Set(router.match(/\d{2}_[A-Z_]+/g) || [])];
    routerIds.forEach(id => {
      const prefix = id.toLowerCase();  // 66_LAB_ANALYSIS_ENGINE → 66_lab_analysis_engine
      const topic = prefix.replace(/^\d+_/, '');  // clinical_reasoning_bridges (fallback)
      const found = manifestIds.some(m => m.startsWith(prefix) || m.includes(topic));
      if (!found)
        errors.push(`KB router ID missing from manifest: ${id} in ${JSON.stringify(routerIds)}}`);
    });
  } catch (e) { errors.push(`KB validation error: ${e.message}`); }
  
  // 4. Database columns
//   try {
//     const { rows } = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='chat_logs'");
//     const cols = rows.map(r => r.column_name);
//     ['id', 'tenant_id', 'msisdn_hash', 'model', 'job_id', 'wa_message_id']
//       .forEach(c => { if (!cols.includes(c)) errors.push(`Missing column: chat_logs.${c}`); });
//   } catch (e) { errors.push(`Database check failed: ${e.message}`); }
  
  // 5. Redis ping
  try { await redis.ping(); } 
  catch (e) { errors.push(`Redis connection failed: ${e.message}`); }
  
  // FAIL FAST
  if (errors.length > 0) {
    console.error('[STARTUP] ❌ VALIDATION FAILED:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.log('[STARTUP] ✅ All validations passed');
}

module.exports = { validateStartup };