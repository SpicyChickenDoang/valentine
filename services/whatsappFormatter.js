// services/whatsappFormatter.js

// BUG-G3 FIX: sleep was called but never defined/imported → ReferenceError on any multi-chunk message
const { setTimeout: sleep } = require('timers/promises');

const MAX_CHUNK = 4000; // leave margin below 4096

// Robust line-by-line table parser — handles malformed/multi-row tables safely
function markdownTablesToText(input) {
  const lines = input.split('\n');
  let out = [], i = 0;
  const isTableRow = l => /\|/.test(l) && l.trim().startsWith('|');
  const isDivider  = l => /^\|\s*:?[-]{3,}/.test(l.trim());
  while (i < lines.length) {
    if (!isTableRow(lines[i])) { out.push(lines[i]); i++; continue; }
    const header = lines[i].split('|').map(c => c.trim()).filter(Boolean); i++;
    if (i < lines.length && isDivider(lines[i])) i++; // skip separator
    out.push('', '*Table*');
    while (i < lines.length && isTableRow(lines[i]) && !isDivider(lines[i])) {
      const cells = lines[i].split('|').map(c => c.trim()).filter(Boolean);
      out.push(`• ` + header.map((h, j) => `${h}: ${cells[j] || '—'}`).join(' | '));
      i++;
    }
    out.push('');
  }
  return out.join('\n');
}

function formatForWhatsApp(text) {
  // 1. Convert tables BEFORE any other processing (never drop clinical data)
  text = markdownTablesToText(text);
  return text
    .replace(/<[^>]+>/g, '')           // strip HTML
    .replace(/#{1,6}\s/g, '*')         // h1-h6 → bold
    .replace(/\*\*(.*?)\*\*/g, '*$1*') // **bold** → *bold*
    .replace(/__(.*?)__/g, '_$1_')    // __italic__ → _italic_
    .replace(/^\s*[-*+]\s/gm, '• ')   // normalize bullets
    .replace(/\n{3,}/g, '\n\n')       // max 2 consecutive newlines
    .trim();
}

function chunkMessage(text, max = MAX_CHUNK) {
  if (text.length <= max) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > max) {
    // find last sentence boundary before limit
    let cut = remaining.lastIndexOf('. ', max);
    if (cut === -1) cut = remaining.lastIndexOf('\n', max);
    if (cut === -1) cut = max; // hard cut
    chunks.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendChunked(waClient, to, rawText) {
  console.log(`[whatsappFormatter] Sending chunked message to ${to}... ${rawText} chars and ${waClient}`);
  
  const formatted = formatForWhatsApp(rawText);
  const chunks = chunkMessage(formatted);
  for (const [i, chunk] of chunks.entries()) {
    await waClient.sendMessage({ to, body: chunk });
    if (i < chunks.length - 1) await sleep(150); // typing feel
  }
}

module.exports = { formatForWhatsApp, chunkMessage, sendChunked };