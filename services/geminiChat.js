// services/geminiChat.js
const axios = require('axios');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const KEY = process.env.GEMINI_API_KEY;

// services/geminiChat.js — add tools to payload
const payload = {
    cachedContent: cacheName,
    contents: [{ role: 'user', parts: userParts }],

    // TOOL DECLARATIONS — Node.js executes, Gemini never computes
    tools: [
        {
            functionDeclarations: [
                {
                    name: "calculate_lab_ratios",
                    description: "Calculates deterministic values from user-provided data. For health: clinical ratios (HOMA-IR, TyG, eGFR). For commerce: prices, availability. MUST be called whenever deterministic computation is required.",
                    parameters: {
                        type: "OBJECT",
                        properties: {
                            markers: {
                                type: "OBJECT",
                                description: "Dictionary of extracted markers. Keys must be standardized (e.g., FBG, TG, HDL, creatinine)."
                            },
                            patient_context: {
                                type: "OBJECT",
                                properties: {
                                    age: { type: "INTEGER" },
                                    sex: { type: "STRING" }
                                }
                            }
                        },
                        required: ["markers"]
                    }
                }
            ]
        }
    ],
    generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
};

async function agentChat({ modelTier, cacheName, kbContext, dossier, history, message, mediaBase64 = null }) {
    const model = modelTier === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';

    // Build dynamic parts (NOT in cache)
    const userParts = [];

    // 1. Inject Medical KB if available (Dynamic RAG)
    if (kbContext) {
        userParts.push({ text: `${kbContext}\n\n---\n` });
    }

    // 2. Inject User Context & History
    userParts.push({ text: `USER CONTEXT:\n${dossier}` });
    // C3 — history elements are {role, content} objects — serialize to string for Gemini parts
    userParts.push(...history
        .filter(h => h.role !== 'system')  // dossier already in dossier field — no double injection
        .slice(-10)
        .map((h) => ({ text: `${h.role}: ${h.content}` })));

    // 3. Inject Current Message & Media
    userParts.push({ text: `Patient: ${message}` });
    if (mediaBase64) {
        userParts.push({ inlineData: { mimeType: 'image/jpeg', data: mediaBase64 } });
    }

    const payload = {
        cachedContent: cacheName,   // <-- attaches the shared cache (agent prompt)
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
    };

    // C7 — wrap axios: detect CACHE_EXPIRED (404), rate limit (429), server errors (5xx)
    // Without this, a Gemini cache expiry causes 100% job crashes for ~400s (gap between Gemini TTL and Redis TTL)
    let data;
    try {
        ({ data } = await axios.post(
            `${GEMINI_API}/${model}:generateContent?key=${KEY}`,
            payload,
            { timeout: 15000 }  // BUG-G8 FIX: 15s inference timeout
        ));
    } catch (e) {
        const status = e.response?.status;
        const errMsg = e.response?.data?.error?.message || '';
        if (status === 404 && errMsg.includes('Cached content')) {
            // Gemini expired the cache before Redis TTL lapsed — force rebuild on next request
            throw Object.assign(new Error('[agentChat] Gemini cache expired — Redis invalidation required'), { code: 'CACHE_EXPIRED' });
        }
        if (status === 429 || status >= 500) throw e;  // BullMQ will retry with backoff
        throw new Error(`[agentChat] Fatal Gemini error ${status}: ${JSON.stringify(e.response?.data)}`);
    }

    // C5 — safety filter / empty response guard (finishReason: SAFETY or empty parts)
    const candidate = data.candidates?.[0];
    if (!candidate || candidate.finishReason === 'SAFETY' || !candidate.content?.parts?.[0]?.text) {
        throw new Error(`[agentChat] Blocked or empty response. Reason: ${candidate?.finishReason}`);
    }
    return {
        text: candidate.content.parts[0].text,
        model: model,
        cachedTokens: data.usageMetadata?.cachedContentTokenCount || 0,
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0
    };
}

// services/geminiChat.js — add geminiChatWithTools() for tool-aware calls
async function geminiChatWithTools({ model, cacheName, userParts, tools }) {
  const payload = {
    cachedContent: cacheName,
    contents: [{ role: 'user', parts: userParts }],
    tools: tools,
    generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
  };
  // BUG-G8 FIX: timeout added
  const { data } = await axios.post(`${GEMINI_API}/${model}:generateContent?key=${KEY}`, payload, { timeout: 15000 });
  const candidate = data.candidates[0];

  // 1. Check if Gemini is requesting a tool call instead of returning text
  if (candidate.content.parts[0].functionCall) {
    const { name, args } = candidate.content.parts[0].functionCall;

    // 2. Execute locally — deterministic math, no LLM involved
    const { calculateLabRatios } = require('./labCalculator');
    let toolResult;
    if (name === 'calculate_lab_ratios') {
      toolResult = calculateLabRatios(args.markers, args.patient_context);
    }

    // 3. Return result to Gemini so it can draft the WhatsApp message
    const followUp = {
      cachedContent: cacheName,
      contents: [
        { role: 'user',  parts: userParts },
        { role: 'model', parts: [{ functionCall: { name, args: args } }] },
        { role: 'user',  parts: [{ functionResponse: { name, response: { result: toolResult } } }] }
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 800 }  // M5: deterministic for clinical math follow-up
    };
    // BUG-G8 FIX: timeout added on followUp call
    const { data: d2 } = await axios.post(`${GEMINI_API}/${model}:generateContent?key=${KEY}`, followUp, { timeout: 15000 });
    // FIX: Normalize return shape to match chatWorker destructuring
    const usage2 = d2.usageMetadata || {};
    return {
      text: d2.candidates[0].content.parts[0].text,
      model: model,
      cachedTokens: usage2.cachedContentTokenCount || 0,
      inputTokens: usage2.promptTokenCount || 0,
      outputTokens: usage2.candidatesTokenCount || 0
    };
  }

  // FIX: Normalize return shape to match chatWorker destructuring
  const usage = data.usageMetadata || {};
  return {
    text: candidate.content.parts[0].text,
    model: model,
    cachedTokens: usage.cachedContentTokenCount || 0,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0
  };
}

// BUG-G5 FIX: geminiChatWithTools must be exported here — agentChat-only export makes tools unreachable
module.exports = { agentChat, geminiChatWithTools };