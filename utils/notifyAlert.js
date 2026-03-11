// utils/notifyAlert.js
const axios = require('axios');
async function notifyAlert(tenantId, payload) {
  const url = process.env.ALERT_WEBHOOK_URL;  // set per tenant
  if (!url) return;  // silent if not configured
  try {
    await axios.post(url, { tenantId, ...payload, ts: new Date().toISOString() }, { timeout: 5000 });  // BUG-G8 FIX: alert webhook must not block
  } catch (e) {
    console.warn('[notifyAlert] failed — non-blocking:', e.message);
  }
}
module.exports = { notifyAlert };
// ALERT_WEBHOOK_URL examples:
//   Slack:  https://hooks.slack.com/services/XXX/YYY/ZZZ
//   WA relay: https://your-domain.com/internal/alert
//   Email:  https://your-email-relay.com/[email protected]