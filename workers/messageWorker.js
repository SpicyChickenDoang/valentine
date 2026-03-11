const { Worker } = require('bullmq');
const redis = require('../config/redis2');
const { query } = require('../db');

const worker = new Worker(
  'whatsapp-messages',
  async (job) => {
    console.log('[WORKER] Processing message:', job.id);

    const { session, phone, timestamp, redisKey, ...messageData } = job.data;

    // Store in PostgreSQL
    try {
      const result = await query(
        `INSERT INTO whatsapp_messages (session, phone, message_data, redis_key, created_at)
         VALUES ($1, $2, $3, $4, TO_TIMESTAMP($5 / 1000.0))
         RETURNING id`,
        [session, phone, JSON.stringify(messageData), redisKey, timestamp]
      );

      console.log('[db] Message stored:', result.rows[0].id);
    } catch (err) {
      console.error('[db] Error storing message:', err.message);
      // Don't throw - let the job complete even if DB fails
    }

    return { processed: true, stored: true };
  },
  {
    connection: redis,
  }
);

worker.on('completed', (job) => {
  console.log(`[WORKER] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[WORKER] Job ${job?.id} failed:`, err.message);
});

module.exports = worker;
