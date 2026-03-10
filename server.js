// server.js
require('dotenv').config();
const app = require('./app');
const port = 3000;

// const { ensurePlatformCache } = require('./services/cacheSetup');
// const redis = require('./services/redis');

async function startServer() {
  // Hash gate + distributed lock handled inside ensurePlatformCache
  // const cacheName = await ensurePlatformCache(redis);
  // process.env.AGENT_CACHE_NAME = cacheName;

  app.listen(port, () => {
    console.log(`[SERVER] USE Engine Agent listening on port ${port}`);
  });

  // Start the message worker
  require('./workers/messageWorker');
}

startServer();

// FIX P2: Graceful shutdown — let BullMQ finish current job before exit
process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[SERVER] SIGINT received, shutting down gracefully...');
  process.exit(0);
});