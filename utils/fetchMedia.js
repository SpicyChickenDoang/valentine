// utils/fetchMedia.js
// C3 — fetchMediaAsBase64 was missing: add the Meta API call here
// Requires: WHATSAPP_TOKEN env var + Meta Graph API media endpoint
async function fetchMediaAsBase64(mediaId) {
    const axios = require('axios');
    // Step 1: resolve media URL from Meta
    // BUG-G10 FIX: timeout:8000 added — BUG-G8 added comment but left options without timeout key
    const { data: meta } = await axios.get(
        `https://graph.facebook.com/v19.0/${mediaId}`,
        { timeout: 8000, headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    // Step 2: download binary
    const { data: buf } = await axios.get(meta.url, {
        timeout: 10000,
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
        responseType: 'arraybuffer'
    });
    return Buffer.from(buf).toString('base64');
}

async function fetchMediaWithFallback(mediaId) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try { return await fetchMediaAsBase64(mediaId); } catch (e) {
            if (attempt === 0) await new Promise(r => setTimeout(r, 500)); // 1 retry, 500ms
        }
    }
    // Media expired or unavailable — return null placeholder, never stall the job
    console.warn('[media] unavailable, continuing without image:', mediaId);
    return null;  // agent prompt handles: "user sent an image that could not be retrieved"
}

module.exports = { fetchMediaWithFallback };  // C3: export added