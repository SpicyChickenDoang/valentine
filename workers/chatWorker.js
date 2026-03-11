// workers/chatWorker.js
const { Worker } = require('bullmq');
const crypto = require('crypto');                         // C1 — needed for msisdnHash
const { GoogleGenAI } = require('@google/genai'); // C2 — using new SDK
const { classifyDepth } = require('../services/depthClassifier');
const { geminiChatWithTools } = require('../services/geminiChat');  // agentChat removed (dead code) — only geminiChatWithTools is used in worker flow
const { resolveKBIds, runPrefilter } = require('../services/kbRouter');    // L1 — runPrefilter exported for DEPTH_0_1 hard-stops
const { loadKBFiles, formatKBContext } = require('../services/kbRetriever');
const { parseCitedObjects, checkCitationMatch } = require('../services/citationParser');
const { extractProfileUpdate } = require('../services/jsonExtractor');    // FIX-1: was missing → ReferenceError on every turn with new patient facts
const { loadPatientContext, formatPatientContext } = require('../services/patientMemory'); // C5 — unified session init
const { notifyAlert } = require('../utils/notifyAlert');
const { fetchMediaWithFallback } = require('../utils/fetchMedia');         // C2 — was missing → ReferenceError on any media message
const { sendChunked } = require('../services/whatsappFormatter');
const waClient = require('../services/whatsappClient');
const { query } = require('../db');
const redis = require('../config/redis2');

// C2 — single geminiClient instance at module level (not per-job)
// FIX P1: Guard against missing GEMINI_API_KEY
if (!process.env.GEMINI_API_KEY) {
    throw new Error('[chatWorker] GEMINI_API_KEY env var missing');
}
const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SAFE_MODE_MESSAGE = 'Our AI assistant is momentarily unavailable. Please try again in a few minutes.';

const worker = new Worker(
    'agent-chat-jobs',
    async (job) => {
        // tenantId + msisdn_id from job.data — never from process.env (multi-tenant safe)
        const { tenantId, msisdn_id, from, message, mediaUrl } = job.data;

        // FIX P2: Input validation — prevent crash on malformed job data
        if (!tenantId || !from) {
            throw new Error(`[chatWorker] Invalid job data: tenantId=${tenantId}, from=${from}`);
        }

        // C1 — msisdnHash declared early, used in session key + SQL INSERT
        const msisdnHash = crypto.createHash('sha256').update(from).digest('hex');

        // 1. Load session — C5: unified pattern, tenant-scoped key, msisdnHash (not raw phone)
        const sessionKey = `${tenantId}:session:${msisdnHash}`;
        const sessionRaw = await redis.get(sessionKey);
        let history = [];
        let dossier = '';
        if (sessionRaw) {
            // FIX P2: try/catch to handle corrupt session data
            try {
                history = JSON.parse(sessionRaw);
            } catch (e) {
                // Redis expired — attempt PostgreSQL rebuild
                const ctx = await loadPatientContext(tenantId, msisdnHash);  // C4 — tenant-scoped

                if (ctx) {
                    // Known patient — silent rebuild, patient sees no gap
                    history = [{
                        role: 'system',
                        content: formatPatientContext(ctx)
                    }];
                    await redis.set(sessionKey, JSON.stringify(history), 'EX', 3600);
                }
                // ctx = null → new patient → empty history → normal onboarding
            }
            // C6 — extract dossier from persisted system slot (was missing → dossier='' on all active sessions)
            dossier = history.find(h => h.role === 'system')?.content || '';
        } else {
            const ctx = await loadPatientContext(tenantId, msisdnHash);  // C4 — tenant-scoped query
            if (ctx) {
                dossier = formatPatientContext(ctx);
                history = [{ role: 'system', content: dossier }];
                await redis.set(sessionKey, JSON.stringify(history), 'EX', 3600);
            }
        }

        // 2. Classify depth — C2: geminiClient passed, C3: history serialized as strings
        // FIX P1: tenantId (ex: reviv_bali) ≠ domain (ex: valentine). Use TENANT_DOMAIN env.
        const tenantDomain = process.env.TENANT_DOMAIN;
        const modelTier = await classifyDepth({
            domain: tenantDomain,
            history: history
                .filter(h => h.role !== 'system')     // F1 — exclude dossier from classifier input
                .slice(-5)
                .map(h => `${h.role}: ${h.content}`)
                .join('\n'),
            message,
            geminiClient  // C2 — was missing, caused silent TypeError → permanent flash fallback
        }).catch(() => 'flash');

        // 3. Get shared cache — C4: guard null (first boot / Redis flush)
        // FIX: use 'let' so we can reassign after retry
        let cacheName = await redis.get(`${tenantId}:agent:cache_name`);
        if (!cacheName) {
            // M2 — give 3s for race condition at startup (container boot), then retry via throw
            await new Promise(r => setTimeout(r, 3000));
            // FIX: reassign cacheName, not new variable
            cacheName = await redis.get(`${tenantId}:agent:cache_name`);
            if (!cacheName) {
                await sendChunked(waClient, from, SAFE_MODE_MESSAGE);
                await notifyAlert(tenantId, { type: 'cache_missing', job_id: job.id });
                throw new Error('CACHE_NOT_READY');  // M2: throw not return — BullMQ retries, message not lost
            }
        }

        // 4. KB retrieval — L1: hard-stops run regardless of depth tier (safety-critical)
        const hardStopIds = runPrefilter(message);       // always run — pregnancy/G6PD/etc must load even on Flash
        let kbContext = '';
        let retrievedIds = [];
        if (hardStopIds.length) {
            const safetyFiles = loadKBFiles(hardStopIds);
            kbContext += formatKBContext(safetyFiles);
            retrievedIds = [...hardStopIds];
        }
        if (modelTier === 'pro') {
            const relevant = loadKBFiles(await resolveKBIds(message, cacheName));
            kbContext += formatKBContext(relevant);
            retrievedIds = [...new Set([...retrievedIds, ...relevant.map(p => p.id)])];
        }

        // 5. Call Gemini — BUG-G1 FIX: stateKey idempotency prevents history poisoning on SQL-crash retry
        // Problem: without this, a retry reads history Redis already containing the prev turn → doubled context → hallucination cascade
        // Solution: persist inference result to Redis BEFORE touching session history or SQL.
        // On retry: fast-path restores state from Redis, skips Gemini, proceeds directly to send+persist.
        const stateKey = `${tenantId}:state:${job.id}`;
        const savedState = await redis.get(stateKey);

        let text, model, cachedTokens, inputTokens, outputTokens, latencyMs, depthClassification, citedIds, citationMatch;

        if (savedState) {
            // FAST-PATH RETRY — inference already done, restore state, skip Gemini call entirely
            ({
                text, model, cachedTokens, inputTokens, outputTokens,
                latencyMs, depthClassification, citedIds, citationMatch
            } = JSON.parse(savedState));
        } else {
            // NORMAL PATH — call Gemini
            // BUG-G13 FIX: agentChat() replaced by geminiChatWithTools() — required by Section 07.
            // agentChat() never attached the Function Declarations → the model could not
            // call calculate_lab_ratios → eGFR, HOMA-IR, and ratios were hallucinated.
            // geminiChatWithTools() sends the tools, intercepts functionCall if returned,
            // executes calculateLabRatios() deterministically, then calls Gemini again with the result.
            // If Gemini does not request a tool (non-clinical message), the path is identical to agentChat().
            const t0 = Date.now();
            try {
                const toolsConfig = [{
                    functionDeclarations: [{
                        name: 'calculate_lab_ratios',
                        description: 'Calculates deterministic biomarker ratios and scores (eGFR CKD-EPI 2021, HOMA-IR, TG/HDL, LDL/HDL) from raw lab values. Always call this before interpreting renal, metabolic, or lipid panels.',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                markers: { type: 'OBJECT', description: 'Raw lab values keyed by biomarker name' },
                                patient_context: { type: 'OBJECT', description: 'Patient metadata: age, sex, weight_kg' }
                            },
                            required: ['markers']
                        }
                    }]
                }];
                const mediaBase64 = mediaUrl ? await fetchMediaWithFallback(mediaUrl) : null;
                const userParts = [
                    ...(kbContext ? [{ text: `KB CONTEXT:\n${kbContext}` }] : []),
                    ...(dossier ? [{ text: `PATIENT DOSSIER:\n${dossier}` }] : []),
                    ...history.filter(h => h.role !== 'system').map(h => ({ text: `${h.role}: ${h.content}` })),
                    { text: `user: ${message}` },
                    ...(mediaBase64 ? [{ inlineData: { mimeType: 'image/jpeg', data: mediaBase64 } }] : [])
                ];
                // FIX: Convert tier to actual Gemini model ID
                const geminiModel = modelTier === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
                const res = await geminiChatWithTools({ model: geminiModel, cacheName, userParts, tools: toolsConfig });
                ({ text, model, cachedTokens, inputTokens, outputTokens } = res);
            } catch (err) {
                console.error('[chatWorker] geminiChatWithTools failed:', err.message);
                await sendChunked(waClient, from, SAFE_MODE_MESSAGE);
                await notifyAlert(tenantId, { type: 'gemini_unavailable', code: err.code, job_id: job.id });
                return;
            }
            latencyMs = Date.now() - t0;
            depthClassification = modelTier === 'pro' ? 'DEPTH_2' : 'DEPTH_0_1';
            citedIds = parseCitedObjects(text);
            citationMatch = checkCitationMatch(retrievedIds, citedIds);
            // Checkpoint: persist inference result before any mutation — idempotency guarantee
            // FIX: NX prevents race condition on concurrent retry — only first worker writes
            const wasSet = await redis.set(stateKey,
                JSON.stringify({
                    text, model, cachedTokens, inputTokens, outputTokens,
                    latencyMs, depthClassification, citedIds, citationMatch
                }),
                'NX', 'EX', 3600);

            if (!wasSet) {
                // Another worker already wrote — restore their result
                const existing = await redis.get(stateKey);
                if (existing) {
                    ({
                        text, model, cachedTokens, inputTokens, outputTokens,
                        latencyMs, depthClassification, citedIds, citationMatch
                    } = JSON.parse(existing));
                }
            }
        }

        // 6. Send & Persist — FIX: claim lock BEFORE side effect to prevent double-send on crash
        const sendStateKey = `${tenantId}:send_state:${job.id}`;
        // FIX: TTL=60s — if crash before sendChunked, retry can proceed after 1 min max
        const sendClaim = await redis.set(sendStateKey, 'sending', 'NX', 'EX', 60);

        if (sendClaim) {
            // We claimed the lock — safe to send
            // FIX P1-GHOSTING: try/catch to release lock on failure, allowing BullMQ retry
            try {
                await sendChunked(waClient, from, text);

                // Update session history only on first send — prevents doubled turns on retry
                const updatedHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: text }];
                const sysEntries = updatedHistory.filter(h => h.role === 'system');
                const turnEntries = updatedHistory.filter(h => h.role !== 'system');
                const trimmed = [...sysEntries, ...turnEntries.slice(-40)];
                await redis.set(sessionKey, JSON.stringify(trimmed), 'EX', 3600);

                // Mark as sent (XX = only if key exists)
                await redis.set(sendStateKey, 'sent', 'XX', 'EX', 3600);
            } catch (err) {
                // CRITICAL: Unlock to allow BullMQ retry to attempt sending again
                await redis.del(sendStateKey);
                throw err;
            }
        } else {
            // Lock exists — check if previous attempt succeeded or is still in progress
            const state = await redis.get(sendStateKey);
            if (state !== 'sent') {
                // Previous send crashed or still in progress — yield to let it complete or retry
                throw new Error('[Gate] Previous send in progress or crashed, yielding to retry');
            }
            // state === 'sent' → message already delivered, skip send but continue to SQL
        }

        // BUG-G12 FIX: dbProcessedKey gate REMOVED — it had become toxic.
        // Raisonnement : les deux mutations SQL sont nativement idempotentes :
        //   UPDATE: DISTINCT UNNEST — retry produces the same state as N=1.
        //   INSERT : ON CONFLICT (job_id) DO NOTHING — retry → no-op silencieux.
        // Anti-pattern gate: if INSERT crashed AFTER redis.set(dbProcessedKey),
        // the gate was set but the INSERT never executed → chat_log MISSING
        // → medical traceability violation (HIPAA/GDPR audit trail).
        // Rule: only use a Redis gate if the underlying SQL mutation
        // n'est PAS structurellement idempotente. Ici elle l'est → gate inutile et dangereuse.
        const profileUpdate = extractProfileUpdate(text);
        if (profileUpdate) {
            // Fetch existing profile to merge arrays
            const existingResult = await query(
                `SELECT allergies, conditions, medications, last_labs, terrain_flags, follow_up_note
                 FROM patient_profiles
                 WHERE tenant_id = $1 AND msisdn_hash = $2`,
                [tenantId, msisdnHash]
            );

            if (existingResult.rows.length > 0) {
                const existing = existingResult.rows[0];
                // Merge arrays with new values, removing duplicates
                const mergedAllergies = [...new Set([...(existing.allergies || []), ...(profileUpdate.allergies || [])])];
                const mergedConditions = [...new Set([...(existing.conditions || []), ...(profileUpdate.conditions || [])])];

                await query(
                    `UPDATE patient_profiles
                     SET allergies = $1,
                         conditions = $2,
                         medications = $3,
                         last_labs = $4,
                         terrain_flags = $5,
                         follow_up_note = $6,
                         updated_at = NOW()
                     WHERE tenant_id = $7 AND msisdn_hash = $8`,
                    [
                        JSON.stringify(mergedAllergies),
                        JSON.stringify(mergedConditions),
                        JSON.stringify(profileUpdate.medications ?? existing.medications),
                        JSON.stringify(profileUpdate.last_labs ?? existing.last_labs),
                        JSON.stringify(profileUpdate.terrain_flags ?? existing.terrain_flags),
                        profileUpdate.follow_up_note ?? existing.follow_up_note,
                        tenantId,
                        msisdnHash
                    ]
                );
            }
        }

        // ON CONFLICT DO NOTHING - prevents duplicate inserts on retry
        await query(
            `INSERT INTO chat_logs (
                tenant_id, msisdn_id, msisdn_hash, model, cached_tokens, input_tokens,
                output_tokens, latency_ms, depth_classification, kb_objects_retrieved,
                kb_objects_cited, citation_match, job_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
            ON CONFLICT (job_id) DO NOTHING`,
            [
                tenantId,
                msisdn_id,
                msisdnHash,
                model,
                cachedTokens,
                inputTokens,
                outputTokens,
                latencyMs,
                depthClassification,
                JSON.stringify(retrievedIds),
                JSON.stringify(citedIds),
                citationMatch,
                String(job.id)
            ]
        );
    },
    { connection: redis, concurrency: 10, limiter: { max: 50, duration: 60000 } }
);

worker.on('failed', (job, err) => console.error(`[WORKER] Job ${job.id} failed:`, err.message));
module.exports = worker;