const express = require('express')
const router = express.Router()
const { addChatJob } = require('../queues/agentQueue')

/**
 * WHA Webhook Handler
 * Receives messages from WHA (WhatsApp HTTP API) and sends directly to chatWorker
 *
 * Expected WHA payload structure:
 * {
 *   "session": "default",
 *   "event": "messages.upsert",
 *   "payload": {
 *     "from": "628123456789@s.whatsapp.net",
 *     "message": { "conversation": "Hello", ... },
 *     "_data": { ... }
 *   }
 * }
 */
router.post('/inbound-message', async (req, res) => {
  try {
    console.log('=== WAHA WEBHOOK RECEIVED ===')
    console.log('Body:', JSON.stringify(req.body, null, 2))

    // Extract data from WHA payload
    const session = req.body.session || 'default'
    const payload = req.body.payload || req.body
    const webhookPayload = req.body

    // Extract phone number (remove @s.whatsapp.net, @lid, etc.)
    const from = payload.from || payload._data?.key?.remoteJid || 'unknown'
    const phone = from.replace(/@.*$/, '') // Clean: remove everything after @
    const fromPhone = payload._data?.key?.remoteJidAlt.replace(/@.*$/, '')

    // Extract message text from various WHA payload formats
    let message = ''
    if (payload.message?.conversation) {
      message = payload.message.conversation
    } else if (payload.message?.extendedTextMessage?.text) {
      message = payload.message.extendedTextMessage.text
    } else if (payload._data?.message?.conversation) {
      message = payload._data.message.conversation
    } else if (payload._data?.message?.extendedTextMessage?.text) {
      message = payload._data.message.extendedTextMessage.text
    }

    // Extract media if present
    let mediaUrl = null
    if (payload.message?.imageMessage?.url) {
      mediaUrl = payload.message.imageMessage.url
    } else if (payload._data?.message?.imageMessage?.url) {
      mediaUrl = payload._data.message.imageMessage.url
    }

    // Validate required fields
    if (!message && !mediaUrl) {
      console.log('[WEBHOOK] No text or media found in message, ignoring')
      return res.status(200).send('OK')
    }

    // Get tenant ID from env (or could be derived from session/phone)
    const tenantId = process.env.TENANT_ID
    if (!tenantId) {
      console.error('[WEBHOOK] TENANT_ID not configured')
      return res.status(500).send('Server configuration error')
    }

    // Add job directly to chatWorker queue
    // const job = await addChatJob({
    //   tenantId,
    //   msisdn_id: phone, // Using phone as msisdn_id
    //   from: phone,
    //   message,
    //   mediaUrl
    // })

    const job = await addChatJob({
      // Tenant & session
      tenantId,
      session: webhookPayload.session,
      // Who we are
      me: webhookPayload.me.id,
      // Message identity
      messageId: webhookPayload.payload.id,
      timestamp: webhookPayload.payload.timestamp,
      // Sender info
      msisdn_id: phone,
      from: fromPhone,
      fromMe: webhookPayload.payload.fromMe,
      pushName: webhookPayload.payload._data.pushName,
      // Message content
      message,
      mediaUrl,
      hasMedia: webhookPayload.payload.hasMedia,
      // Key (for reply/ack targeting)
      key: webhookPayload.payload._data.key,
      // Source
      source: webhookPayload.payload.source,
    })


    console.log(`[WEBHOOK] Added chat job ${job.id} for ${phone}`)
    console.log('==============================')
    res.status(200).send('OK')

  } catch (error) {
    console.error('[WEBHOOK] Failed to process message:', error)
    res.status(500).json({ error: error.message })
  }
})

module.exports = router