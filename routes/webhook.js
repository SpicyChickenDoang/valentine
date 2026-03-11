// routes/webhook.js
const express = require('express');
const { agentQueue } = require('../queues/agentQueue');
const router = express.Router();

// Meta webhook verification
router.get('/message/whatsapp', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

// Inbound messages
router.post('/message/whatsapp', async (req, res) => {
  const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg = entry?.messages?.[0];
  if (!msg) return res.sendStatus(200); // ack immediately

  // tenantId = which clinic/brand (REVIV, InfusionBali…) — set per WABA instance in env
  // msisdn_id = the platform WhatsApp number ID (phone_number_id from Meta)
  // `from` = raw WhatsApp number — enqueued for worker routing only.
  // Rule: `from` is NEVER stored in DB. Worker hashes it: msisdnHash = SHA256(from).
  // Only msisdnHash is written to chat_logs and used as session key.
  // FIX: Deterministic jobId prevents duplicate jobs on webhook retry (Meta sends 5x)
  await agentQueue.add('chat', {
    tenantId: process.env.TENANT_ID,
    msisdn_id: entry.metadata.phone_number_id,
    from: msg.from,
    message: msg.text?.body || '',
    mediaUrl: msg.image?.id || msg.document?.id || null,
    timestamp: msg.timestamp
  }, {
    jobId: msg.id,  // wamid.xxx — stable per message, deduplicates on retry
    removeOnComplete: 100,
    removeOnFail: 50
  });
  res.sendStatus(200); // ack before processing
});

module.exports = router;