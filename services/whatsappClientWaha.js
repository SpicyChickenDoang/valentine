// services/whatsappClientWaha.js
// WhatsApp HTTP API (Waha) client — for self-hosted WHA solution
// Alternative to Meta Cloud API

const axios = require('axios');

// Environment variables
const WHA_BASE_URL = 'https://waha.aiprojectbali.com';
// const WHA_BASE_URL = process.env.WHA_BASE_URL || 'https://waha.aiprojectbali.com';
const WHA_SESSION = process.env.WHA_SESSION || 'default';

// Create axios instance with defaults
const client = axios.create({
  baseURL: WHA_BASE_URL,
  timeout: 10000,  // 10s timeout
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': process.env.WAHA_API_KEY
  }
});

/**
 * Send a text message via WHA (WhatsApp HTTP API)
 * @param {Object} options
 * @param {string} options.to - Recipient phone number (with country code, no +)
 * @param {string} options.body - Message text
 * @param {string} [options.session] - Override default session name
 * @returns {Promise<Object>} - API response
 */
async function sendMessage({ to, body, session = WHA_SESSION }) {
  const sessionName = session || WHA_SESSION;

  // Clean phone number - remove any @s.whatsapp.net, +, etc.
  const cleanPhone = to.replace(/[^\d]/g, '');

  try {
    const { data } = await client.post('/api/sendText', {
      session: sessionName,
      chatId: `${cleanPhone}@s.whatsapp.net`,
      text: body
    });

    console.log('[whatsappClientWaha] Message sent:', {
      to: cleanPhone.slice(0, 6) + '***',
      session: sessionName
    });

    return {
      success: true,
      messageId: data?.id || null,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('[whatsappClientWaha] Send failed:', {
      status: err.response?.status,
      message: err.response?.data?.message || err.message,
      to: cleanPhone.slice(0, 6) + '***'
    });

    throw err;
  }
}

/**
 * Mark message as read (optional — improves UX)
 */
async function markAsRead(messageId, session) {
  const sessionName = session || WHA_SESSION;
  try {
    await client.post('/api/readMessage', {
      session: sessionName,
      messageId: messageId
    });
  } catch (err) {
    // Non-critical — log and continue
    console.warn('[whatsappClientWaha] markAsRead failed:', err.message);
  }
}

/**
 * Check session health/status
 */
async function checkSession(session) {
  const sessionName = session || WHA_SESSION;
  try {
    const { data } = await client.get(`/api/sessionState/${sessionName}`);
    return {
      connected: data?.status === 'authenticated',
      status: data?.status
    };
  } catch (err) {
    return {
      connected: false,
      status: 'unknown',
      error: err.message
    };
  }
}

module.exports = { sendMessage, markAsRead, checkSession };
