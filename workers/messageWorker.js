const { Worker } = require('bullmq');
const redis = require('../config/redis');
const supabase = require('../config/supabase');

const worker = new Worker(
  'whatsapp-messages',
  async (job) => {
    console.log('[WORKER] Processing message:', job.id);

    const { session, phone, timestamp, redisKey, ...messageData } = job.data;

    // Store in Supabase
    try {
      const { data, error } = await supabase
        .from('whatsapp_messages')
        .insert({
          session,
          phone,
          message_data: messageData,
          redis_key: redisKey,
          created_at: new Date(timestamp).toISOString(),
        })
        .select();

      if (error) {
        console.error('[SUPABASE] Insert failed:', error.message);
        throw error;
      }

      console.log('[SUPABASE] Message stored:', data[0].id);
    } catch (err) {
      console.error('[SUPABASE] Error:', err.message);
      // Don't throw - let the job complete even if Supabase fails
    }

    return { processed: true, stored: true };
  },
  {
    connection: {
      host: 'localhost',
      port: 6379,
    },
  }
);

worker.on('completed', (job) => {
  console.log(`[WORKER] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[WORKER] Job ${job?.id} failed:`, err.message);
});

module.exports = worker;
