// services/redis2.js
// Redis client — single instance for all operations (sessions, locks, cache)
// Uses ioredis for reliability and Lua scripting support

const Redis = require('ioredis');

// Parse REDIS_URL or use defaults
const redisUrl = 'redis://localhost:6379' ||  process.env.REDIS_URL;

const redis = new Redis(redisUrl, {
  // Connection settings
  maxRetriesPerRequest: null,       // Retry failed commands
  retryDelayOnFailover: 100,     // Wait 100ms between retries
  enableReadyCheck: true,        // Verify connection before use
  
  // Reconnection strategy
  retryStrategy(times) {
    if (times > 10) {
      console.error('[redis] Max reconnection attempts reached');
      return null; // Stop retrying
    }
    return Math.min(times * 100, 3000); // Exponential backoff, max 3s
  },
  
  // Timeout settings
  connectTimeout: 10000,        // 10s connection timeout
  commandTimeout: 5000,         // 5s per command (prevents worker hang)
});

// Event handlers
redis.on('connect', () => console.log('[redis] Connected'));
redis.on('error', (err) => console.error('[redis] Error:', err.message));
redis.on('close', () => console.warn('[redis] Connection closed'));

// Health check
async function healthCheck() {
  try {
    const pong = await redis.ping();
    console.log('[redis] Health:', pong);
    return pong === 'PONG';
  } catch (err) {
    console.error('[redis] Health check failed:', err.message);
    return false;
  }
}

module.exports = redis;
module.exports.healthCheck = healthCheck;