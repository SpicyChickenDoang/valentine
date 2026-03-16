// utils/notifyAlert.js
const { sendMessage } = require('../services/whatsappClientWaha');

async function notifyAlert(tenantId, payload) {
  const alertPhones = process.env.ALERT_PHONE_NUMBER?.split(',').map(p => p.trim()) || [];
  if (alertPhones.length === 0) {
    console.warn('[notifyAlert] ALERT_PHONE_NUMBER not configured — skipping');
    return;
  }

  // Format alert message for WhatsApp
  const jakartaTime = new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" });
  const body = `🚨 *ALERT* 🚨
    *Tenant:* ${tenantId}
    *Type:* ${payload.type}
    *Job ID:* ${payload.job_id || 'N/A'}
    *Payload:* ${JSON.stringify(payload)}
    *Time:* ${jakartaTime}`;

  // Send to all configured numbers (parallel, non-blocking)
  await Promise.allSettled(alertPhones.map(async (phone) => {
    try {
      await sendMessage({ to: phone, body });
      console.log(`[notifyAlert] Alert sent to ${phone.slice(0, 6)}***`);
    } catch (e) {
      console.warn(`[notifyAlert] Failed to send to ${phone.slice(0, 6)}***:`, e.message);
    }
  }));
}

module.exports = { notifyAlert };