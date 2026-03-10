const express = require('express')
const router = express.Router()
const redis = require('../config/redis')
const messageQueue = require('../queues/messageQueue')

router.post('/inbound-message', async (req, res) => {
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

module.exports = router
