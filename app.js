const express = require('express')
const app = express()
const redis = require('./config/redis')
const messageQueue = require('./queues/messageQueue')

// Parse JSON bodies
app.use(express.json())

// Log ALL incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`)
  console.log('Headers:', JSON.stringify(req.headers, null, 2))
  next()
})

app.get('/', (req, res) => {
  res.send('Hello World!')
})

// Check Redis and Queue status
app.get('/status', async (req, res) => {
  try {
    // Get Redis keys
    const keys = await redis.keys('waha:message:*')
    const messages = []

    // Get last 10 messages from Redis
    for (const key of keys.slice(-10)) {
      const data = await redis.get(key)
      messages.push({ key, data: JSON.parse(data) })
    }

    // Get queue stats
    const queueStats = {
      waiting: await messageQueue.getWaitingCount(),
      active: await messageQueue.getActiveCount(),
      completed: await messageQueue.getCompletedCount(),
      failed: await messageQueue.getFailedCount(),
    }

    res.json({
      redis: {
        totalMessages: keys.length,
        recentMessages: messages,
      },
      queue: queueStats,
    })
  } catch (error) {
    console.error('[ERROR] Status check failed:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/inbound-message', async (req, res) => {
  try {
    console.log('=== WAHA WEBHOOK RECEIVED ===')
    console.log('Body:', JSON.stringify(req.body, null, 2))

    // Extract session and phone number
    const session = req.body.session
    const from = req.body.payload?.from || req.body.payload?._data?.key?.remoteJid || 'unknown'
    const phone = req.body.payload?._data?.key?.remoteJidAlt.split('@')[0] // Remove @lid, @s.whatsapp.net, etc.
    const timestamp = Date.now()

    // Use session + phone as key
    const key = `waha:message:${session}:${phone}:${timestamp}`
    await redis.set(key, JSON.stringify(req.body))
    await redis.expire(key, 86400) // Expire in 24 hours
    console.log(`[REDIS] Stored message with key: ${key}`)

    // Add to BullMQ queue
    const job = await messageQueue.add('process-message', {
      ...req.body,
      timestamp,
      redisKey: key,
      session,
      phone,
    })
    console.log(`[QUEUE] Added job ${job.id} to queue`)

    console.log('==============================')
    res.status(200).send('OK')
  } catch (error) {
    console.error('[ERROR] Failed to process message:', error)
    res.status(500).send('Internal Server Error')
  }
})

// 404 handler
app.use((req, res) => {
  console.log('404 - Route not found:', req.method, req.url)
  res.status(404).send('Not Found')
})

module.exports = app
