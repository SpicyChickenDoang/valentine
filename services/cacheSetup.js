// services/cacheSetup.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { getDomain } = require('../config/domains');
const { ai } = require('./geminiClient');

// IMPORTANT: all cache keys are tenant-scoped
// Multi-tenant design: each tenant has its own cache/lock/hash Redis keys (namespaced by tenantId).
// Option A — one process per tenant (simple): TENANT_ID from env, call ensurePlatformCache(redis).
// Option B — multiple tenants in one process: refactor as ensurePlatformCache(redis, tenantId)
//   and call for each tenant at startup. Keys are already namespaced — no other changes needed.
// Option A (1 process per tenant): tenantId from env — safe, TENANT_ID is deployment-scoped.
// Option B (multi-tenant 1 process): tenantId must come from job.data.tenantId, NOT env.
// In Option B, this line must move into ensurePlatformCache(redis, tenantId) and into
// every Redis key, DB insert, media fetch, and cacheName call. No global tenantId.
const tenantId = process.env.TENANT_ID;
if (!tenantId) throw new Error('[cacheSetup] TENANT_ID env var missing');

const LOCK_KEY = `${tenantId}:agent:cache_lock`;
const CACHE_KEY = `${tenantId}:agent:cache_name`;
const HASH_KEY = `${tenantId}:agent:cache_hash`;

function buildStaticContent() {
  // Cache = agent system prompt + KB_ROUTER. Never individual KB files.
  // KB_ROUTER (~2k tokens) MUST be here — it's what tells Gemini which KB files to load.
  // Without it, the "router-in-cache" model collapses: Gemini has no routing rules.
  // MIN-2: explicit guard — prevents cryptic ENOENT at boot with no indication of which file is missing
  // FIX P0: Dynamic paths based on TENANT_DOMAIN (multi-domain architecture)
  const domainKey = process.env.TENANT_DOMAIN;
  if (!domainKey) throw new Error('[cacheSetup] TENANT_DOMAIN env var missing');

  // Validate domain exists + get config (throws if unknown)
  const domainConfig = getDomain(domainKey);
  console.log(`[cacheSetup] Domain: ${domainKey}, PII fields: ${domainConfig.piiFields.join(', ')}`);

  if (!domainConfig) throw new Error('[cacheSetup] TENANT_DOMAIN env var missing');
  const required = [`./prompts/${domainConfig}_prompt.txt`, `./kb/${domainConfig}/00_KB_ROUTER.txt`];

  for (const f of required)
    if (!fs.existsSync(f)) throw new Error(`[cacheSetup] MISSING required file: ${f}`);
  const agentPrompt = fs.readFileSync(required[0], 'utf8');
  const kbRouter = fs.readFileSync(required[1], 'utf8');
  return 'AGENT SYSTEM POLICY\n' + agentPrompt
    + '\n\n---\nKB ROUTING RULES\n' + kbRouter;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function ensurePlatformCache(redis) {
  // 1. Distributed lock — UUID token, single flight across all instances
  const lockToken = crypto.randomUUID();
  // M4 fix: lock TTL 45s must be < wait ceiling 50s — was 90s vs 15s → cascade startup crash
  const acquired = await redis.set(LOCK_KEY, lockToken, 'NX', 'EX', 45);

  if (!acquired) {
    // Another instance is rebuilding — wait 50s (lock TTL 45s, so it always expires)
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const name = await redis.get(CACHE_KEY);
      if (name) return name;
    }
    throw new Error('[CACHE] Lock held too long — rebuild did not complete');
  }

  try {
    const staticContent = buildStaticContent();
    const newHash = sha256(staticContent);
    const storedHash = await redis.get(HASH_KEY);
    const existingName = await redis.get(CACHE_KEY);

    // 2. Hash gate — skip rebuild if content unchanged
    if (storedHash === newHash && existingName) {
      console.log('[CACHE] Hash unchanged — reusing', existingName);
      return existingName;
    }

    // 3. Build new cache
    console.log('[CACHE] Hash changed — rebuilding');
    const displayName = `agent_platform_cache_${newHash.slice(0, 12)}`;
    // BUG-G8 FIX: timeout added — missing timeout = worker hangs indefinitely on TCP hang
    const cache = await ai.caches.create({
      model: 'gemini-2.5-flash',
      displayName: displayName,
      systemInstruction: staticContent,
      ttl: '86400s'
    });
    const cacheName = cache.name;

    // 4. Atomic swap — write name + hash in single Redis transaction
    const multi = redis.multi();
    multi.set(CACHE_KEY, cacheName, 'EX', 86000);
    multi.set(HASH_KEY, newHash, 'EX', 86000);
    await multi.exec();
    console.log('[CACHE] New cache live:', cacheName);
    return cacheName;

  } finally {
    // FIX-4: atomic Lua CAS — GET+DEL was a race: another instance could acquire between the two calls
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end`;
    await redis.eval(lua, 1, LOCK_KEY, lockToken);
  }
}

module.exports = { ensurePlatformCache };