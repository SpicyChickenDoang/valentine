// routes/status.js
const express = require('express');
const redis = require('../config/redis2');
const { agentQueue } = require('../queues/agentQueue');
const { ai } = require('../services/geminiClient');
const router = express.Router();

const tenantId = process.env.TENANT_ID;
const LOCK_KEY = `${tenantId}:agent:cache_lock`;
const CACHE_KEY = `${tenantId}:agent:cache_name`;
const HASH_KEY = `${tenantId}:agent:cache_hash`;

/**
 * GET /status/cache
 * Returns platform cache health status including:
 * - Redis connection status
 * - Cache existence and validity
 * - Cache hash info
 * - Lock status
 */
router.get('/cache', async (req, res) => {
  try {
    // Check Redis connection
    const redisPing = await redis.ping();

    // Get cache data
    const cacheData = await redis.get(CACHE_KEY);
    const storedHash = await redis.get(HASH_KEY);
    const lockValue = await redis.get(LOCK_KEY);
    const lockTTL = lockValue ? await redis.ttl(LOCK_KEY) : null;

    // Parse cache names if exists
    let parsedCache = null;
    if (cacheData) {
      try {
        parsedCache = JSON.parse(cacheData);
      } catch (e) {
        parsedCache = { raw: cacheData, parseError: 'Failed to parse as JSON' };
      }
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      tenantId,
      redis: {
        connected: redisPing === 'PONG',
      },
      cache: {
        exists: !!cacheData,
        hash: storedHash || null,
        names: parsedCache,
        isValidFormat: parsedCache && parsedCache['gemini-2.5-flash'] && parsedCache['gemini-2.5-pro'],
      },
      lock: {
        held: !!lockValue,
        ttl: lockTTL, // seconds until lock expires, -2 if key doesn't exist, -1 if no expiry
      },
    });
  } catch (error) {
    console.error('[STATUS] Cache check failed:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

/**
 * GET /status/queue
 * Returns BullMQ queue statistics
 */
router.get('/queue', async (req, res) => {
  try {
    const stats = {
      waiting: await agentQueue.getWaitingCount(),
      active: await agentQueue.getActiveCount(),
      completed: await agentQueue.getCompletedCount(),
      failed: await agentQueue.getFailedCount(),
      delayed: await agentQueue.getDelayedCount(),
      paused: await agentQueue.isPaused(),
    };

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      tenantId,
      queue: stats,
    });
  } catch (error) {
    console.error('[STATUS] Queue check failed:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

/**
 * GET /status/caches
 * Lists all Gemini cached contents from the API
 */
router.get('/caches', async (_req, res) => {
  try {
    const caches = [];
    const pager = await ai.caches.list({ config: { pageSize: 10 } });
    let page = pager.page;

    while (true) {
      for (const c of page) {
        caches.push({
          name: c.name,
          model: c.model,
          createTime: c.createTime,
          updateTime: c.updateTime,
          expireTime: c.expireTime,
        });
      }
      if (!pager.hasNextPage()) break;
      page = await pager.nextPage();
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      count: caches.length,
      caches,
    });
  } catch (error) {
    console.error('[STATUS] Cache list failed:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

/**
 * GET /status/queue/failed
 * Lists all failed jobs with their details
 */
router.get('/queue/failed', async (_req, res) => {
  try {
    const failedJobs = await agentQueue.getFailed(0, 100);

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      count: failedJobs.length,
      jobs: failedJobs.map(job => ({
        id: job.id,
        name: job.name,
        failedReason: job.failedReason,
        stacktrace: job.stacktrace,
        attemptsMade: job.attemptsMade,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        data: job.data,
      })),
    });
  } catch (error) {
    console.error('[STATUS] Failed jobs list failed:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

/**
 * POST /status/queue/retry/:jobId
 * Retries a failed job by moving it back to the waiting queue
 */
router.post('/queue/retry/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({
        status: 'error',
        error: 'Job ID is required',
      });
    }

    const job = await agentQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({
        status: 'error',
        error: `Job ${jobId} not found`,
      });
    }

    await job.retry();
    console.log(`[STATUS] Job ${jobId} has been moved back to the waiting queue.`);

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      message: `Job ${jobId} has been moved back to the waiting queue.`,
    });
  } catch (error) {
    console.error('[STATUS] Job retry failed:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

/**
 * DELETE /status/caches/:name
 * Deletes a Gemini cache by name
 */
router.delete('/caches/:name', async (req, res) => {
  try {
    const { name } = req.params;

    if (!name) {
      return res.status(400).json({
        status: 'error',
        error: 'Cache name is required',
      });
    }

    await ai.caches.delete({ name });

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      message: `Cache '${name}' deleted successfully`,
    });
  } catch (error) {
    console.error('[STATUS] Cache delete failed:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

/**
 * GET /status/health
 * Overall health check (cache + queue + redis)
 */
router.get('/health', async (req, res) => {
  try {
    const redisPing = await redis.ping();
    const cacheData = await redis.get(CACHE_KEY);
    const storedHash = await redis.get(HASH_KEY);

    let parsedCache = null;
    if (cacheData) {
      try {
        parsedCache = JSON.parse(cacheData);
      } catch (e) {
        parsedCache = { error: 'Failed to parse' };
      }
    }

    const queueStats = {
      waiting: await agentQueue.getWaitingCount(),
      active: await agentQueue.getActiveCount(),
      failed: await agentQueue.getFailedCount(),
    };

    // Determine overall health
    const isHealthy =
      redisPing === 'PONG' &&
      cacheData &&
      parsedCache &&
      parsedCache['gemini-2.5-flash'] &&
      parsedCache['gemini-2.5-pro'];

    res.json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      tenantId,
      checks: {
        redis: { healthy: redisPing === 'PONG' },
        cache: {
          healthy: !!(cacheData && parsedCache && parsedCache['gemini-2.5-flash'] && parsedCache['gemini-2.5-pro']),
          hash: storedHash,
        },
        queue: {
          healthy: queueStats.failed < 100, // arbitrary threshold
          stats: queueStats,
        },
      },
    });
  } catch (error) {
    console.error('[STATUS] Health check failed:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

module.exports = router;
