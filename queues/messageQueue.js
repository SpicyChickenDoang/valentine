const { Queue } = require('bullmq');
const redis = require('../config/redis');

const messageQueue = new Queue('whatsapp-messages', {
  connection: {
    host: 'localhost',
    port: 6379,
  },
});

module.exports = messageQueue;
