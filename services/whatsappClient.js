// services/whatsappClient.js
// WhatsApp Cloud API client — wraps Meta Graph API with timeout and retry
// CRITICAL: All external calls must have timeout to prevent worker hang

const axios = require('axios');

// FIX P1: Guard against missing WHATSAPP_TOKEN
if (!process.env.WHATSAPP_TOKEN) {
  throw new Error('[whatsappClient] WHATSAPP_TOKEN env var missing');
}

const WA_API_VERSION = 'v19.0';
const WA_BASE_URL = `https://graph.facebook.com/${WA_API_VERSION}`;

// Create axios instance with defaults
const client = axios.create({
  baseURL: WA_BASE_URL,
  timeout: 10000,  // 10s timeout — WA API typically responds in 200-500ms
  headers: {
    'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

/**
 * Send a text message via WhatsApp Cloud API
 * @param {Object} options
 * @param {string} options.to - Recipient phone number (with country code, no +)
 * @param {string} options.body - Message text
 * @param {string} [options.phoneNumberId] - Override default phone number ID
 * @returns {Promise<Object>} - API response with message ID
 */
async function sendMessage({ to, body, phoneNumberId }) {
  const fromId = phoneNumberId || process.env.WA_PHONE_NUMBER_ID;
  
  if (!fromId) {
    throw new Error('[whatsappClient] WA_PHONE_NUMBER_ID not configured');
  }

  try {
    const { data } = await client.post(`/${fromId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: { body: body }
    });
    
    return {
      success: true,
      messageId: data.messages?.[0]?.id,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    const status = err.response?.status;
    const waError = err.response?.data?.error;
    
    console.error('[whatsappClient] Send failed:', {
      status,
      code: waError?.code,
      message: waError?.message || err.message,
      to: to.slice(0, 6) + '***'  // PII safe logging
    });
    
    // Rethrow with context for worker error handling
    throw Object.assign(err, {
      waCode: waError?.code,
      waMessage: waError?.message,
      isRateLimit: status === 429,
      isServerError: status >= 500
    });
  }
}

/**
 * Mark message as read (optional — improves UX)
 */
async function markAsRead(messageId, phoneNumberId) {
  const fromId = phoneNumberId || process.env.WA_PHONE_NUMBER_ID;
  try {
    await client.post(`/${fromId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    });
  } catch (err) {
    // Non-critical — log and continue
    console.warn('[whatsappClient] markAsRead failed:', err.message);
  }
}

module.exports = { sendMessage, markAsRead };