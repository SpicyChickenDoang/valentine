const express = require('express')
const app = express()
const redis = require('./config/redis')
const messageQueue = require('./queues/messageQueue')
const inboundMessageRoutes = require('./routes/inboundMessage')

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

// Inbound message routes
app.use('/', inboundMessageRoutes)

// 404 handler
app.use((req, res) => {
  console.log('404 - Route not found:', req.method, req.url)
  res.status(404).send('Not Found')
})

module.exports = app
