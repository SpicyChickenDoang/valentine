// const { Queue } = require('bullmq');
// const redis = require('../config/redis');

// const messageQueue = new Queue('whatsapp-messages', {
//   connection: {
//     host: 'localhost',
//     port: 6379,
//   },
// });

// module.exports = messageQueue;

// queues/agentQueue.js
// BullMQ queue for async WhatsApp message processing
// Domain-agnostic: same queue handles all tenants (valentine, majordome, etc.)

const { Queue } = require('bullmq');
// const redis = require('../services/redis');
const redis = require('../config/redis2');

// Single queue for all agent chat jobs — tenant isolation via job.data.tenantId
const agentQueue = new Queue('agent-chat-jobs', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000  // 1s, 2s, 4s
    },
    removeOnComplete: 100,  // Keep last 100 completed jobs
    removeOnFail: 50        // Keep last 50 failed jobs
  }
});

module.exports = { agentQueue };
