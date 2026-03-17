# USE Engine Agent

A WhatsApp-based AI agent system powered by Google Gemini that provides intelligent conversational responses with knowledge base integration, patient context management, and multi-tenant support.

## Version

**Current Release: v1.0.0**

This is the first stable release of the USE Engine Agent, featuring complete end-to-end WhatsApp integration with AI-powered responses.

## Features

- **WhatsApp Integration**: Receives and processes messages via WHA (WhatsApp HTTP API) webhooks
- **AI-Powered Responses**: Uses Google Gemini 2.5 (Flash & Pro models) with context caching
- **Knowledge Base System**: Intelligent routing and retrieval of domain-specific knowledge files
- **Patient Context Management**: Maintains patient profiles and conversation history in PostgreSQL
- **Depth Classification**: Automatically classifies conversation complexity to select appropriate AI model
- **Multi-Tenant Support**: Supports multiple domains with tenant-scoped data isolation
- **Media Processing**: Handles image/media messages with Gemini vision analysis
- **Queue-Based Processing**: Uses BullMQ for reliable job processing with retry logic
- **Graceful Degradation**: Safe-mode fallbacks for error scenarios

## Architecture

```
├── app.js              # Express app setup & middleware
├── server.js           # Server entry point with startup validation
├── config/             # Redis & domain configuration
├── controller/         # Media download & processing
├── kb/                 # Knowledge base files (JSON)
├── queues/             # BullMQ job queues
├── routes/             # Express route handlers
├── services/           # Core business logic
│   ├── geminiChat.js   # Gemini API integration with tools
│   ├── kbRouter.js     # Knowledge base routing
│   ├── kbRetriever.js  # KB file loading
│   ├── depthClassifier.js  # Conversation depth classification
│   ├── patientDb.js    # PostgreSQL operations
│   ├── patientMemory.js    # Patient context management
│   └── whatsappClient.js   # WhatsApp API client
├── utils/              # Helper utilities
└── workers/            # Background job processors
```

## Tech Stack

- **Runtime**: Node.js with CommonJS
- **Web Framework**: Express 5.x
- **Database**: PostgreSQL with `pg` driver
- **Cache/Queue**: Redis with BullMQ
- **AI**: Google Gemini via `@google/genai` SDK
- **Storage**: Supabase (for media storage)

## Prerequisites

- Node.js 18+
- PostgreSQL 12+
- Redis 6+
- Ngrok (for local development webhooks)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd use-engine-agent
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TENANT_ID` | Tenant identifier | Yes |
| `TENANT_DOMAIN` | Domain for KB routing (e.g., `valentine`) | Yes |
| `GEMINI_API_KEY` | Google Gemini API key | Yes |
| `POSTGRES_HOST` | PostgreSQL host | Yes |
| `POSTGRES_USER` | PostgreSQL user | Yes |
| `POSTGRES_PASSWORD` | PostgreSQL password | Yes |
| `POSTGRES_DB` | PostgreSQL database | Yes |
| `REDIS_HOST` | Redis host | Yes |
| `REDIS_PORT` | Redis port | Yes |
| `SUPABASE_URL` | Supabase URL | Yes |
| `SUPABASE_KEY` | Supabase service key | Yes |

## Running the Application

### Development

Start the server:
```bash
npm run dev
```

The server will start on port 3000.

### With Docker Compose

Start PostgreSQL and Redis:
```bash
docker-compose up -d
```

### With Ngrok (for webhooks)

```bash
npm run ngroka  # or npm run ngroke
```

## API Endpoints

### Health & Status

- `GET /` - Health check
- `GET /status` - Queue and Redis status
- `GET /status/sessions` - Active sessions count

### Webhooks

- `POST /inbound-message` - WhatsApp message webhook receiver

## Database Schema

### Tables

- **patients**: Stores patient profiles with extracted facts
- **chat_logs**: Complete audit trail of all conversations
- **escalations**: Tracks escalated/failed conversations for follow-up

## Knowledge Base Structure

Knowledge files are stored in `/kb/` directory:
- `index.json`: Master index of all KB entries
- `json/`: Individual KB files organized by ID
- `valentine/`: Domain-specific knowledge

Each KB file contains:
- `id`: Unique identifier
- `content`: Knowledge content with visibility keys (_public, _private, etc.)

## End-to-End Flow

### Overview Diagram

```
WhatsApp User → WHA Webhook → Express Route → BullMQ Queue → chatWorker → Gemini AI → WhatsApp Response
                                            ↓
                                    Redis/PostgreSQL
```

### Detailed Flow Breakdown

#### Phase 1: Message Reception (Webhook Layer)

**Trigger**: User sends a message on WhatsApp

1. **WHA (WhatsApp HTTP API)** receives the message from WhatsApp servers
2. **WHA sends webhook** to `POST /inbound-message` endpoint
3. **Express middleware** logs the incoming request with timestamp
4. **Route handler** (`routes/inboundMessage.js`) processes the payload:
   - Extracts session, phone number, and message content
   - Checks if message is from the bot (ignores bot's own messages)
   - Filters non-message events (session status, etc.)
   - Extracts media URL/images if present
   - Downloads and processes media using Gemini Vision API
   - Validates required fields (tenant ID, phone, message)

#### Phase 2: Job Queuing (Queue Layer)

5. **Route handler** adds a job to BullMQ queue:
   ```javascript
   const job = await addChatJob({
     tenantId,           // Multi-tenant identifier
     msisdn_id,          // User's phone number
     from,               // Clean phone number
     message,            // Text message content
     mediaUrl,           // Media URL (if any)
     mediaBase64,        // Base64 encoded media
     mediaMimeType,      // Media type (image/jpeg, etc.)
     mediaGeminiResult,  // Gemini's analysis of media
     key,                // WhatsApp message key for replying
     timestamp,          // Message timestamp
     pushName,           // User's WhatsApp display name
   })
   ```

6. **Job is queued** in Redis under `agent-chat-jobs` queue
7. **Express responds** with `200 OK` to WHA (acknowledging receipt)
8. **WHA removes** message from its queue (no duplicate processing)

#### Phase 3: Worker Processing (Background Layer)

**Trigger**: BullMQ worker picks up the job (`workers/chatWorker.js`)

8. **Input Validation**: Worker validates tenant ID and phone number
9. **MSISDN Hash Generation**: Creates SHA-256 hash of phone number for privacy
10. **Session Loading**: Attempts to load conversation history from Redis:
    ```javascript
    const sessionKey = `${tenantId}:session:${msisdnHash}`
    const sessionRaw = await redis.get(sessionKey)
    ```

11. **Session Fallback** (if Redis miss):
    - Queries PostgreSQL for existing patient context
    - Rebuilds conversation history from database
    - Stores back in Redis with 1-hour expiration

#### Phase 4: Depth Classification (AI Routing Layer)

12. **Conversation Analysis**: Classifies message complexity using Gemini:
    - Input: Last 5 messages + current message
    - Output: `flash` (simple) or `pro` (complex) model tier
    - Factors: Medical terminology, lab results, drug calculations

13. **Cache Selection**: Retrieves cached prompts for the model tier:
    ```javascript
    const cacheNames = JSON.parse(await redis.get(`${tenantId}:agent:cache_name`))
    // Returns: { 'gemini-2.5-flash': 'cache_name_flash', 'gemini-2.5-pro': 'cache_name_pro' }
    ```

#### Phase 5: Knowledge Base Retrieval (Context Layer)

14. **Hard-Stop Prefilter** (safety-critical, always runs):
    - Checks for pregnancy-related keywords
    - Checks for G6PD deficiency mentions
    - Checks for drug interactions
    - Loads relevant safety KB files regardless of depth

15. **Semantic Routing** (if Pro tier):
    - Calls `kbRouter.resolveKBIds()` with cached prompt
    - Embeds query and searches KB index
    - Returns top relevant KB file IDs
    - Loads actual KB content from `/kb/` directory

16. **Context Assembly**: Formats all retrieved KB files:
    ```javascript
    KB CONTEXT:
    --- KB FILE 1 ---
    {id, content: {...}}
    --- KB FILE 2 ---
    {id, content: {...}}
    ```

#### Phase 6: AI Inference (Gemini Layer)

17. **Message Construction**: Assembles all context parts:
    ```javascript
    const userParts = [
      { text: 'KB CONTEXT:\n...' },           // Retrieved knowledge
      { text: 'PATIENT DOSSIER:\n...' },      // Patient history
      ...history.map(h => ({ text: h })),     // Conversation history
      { text: `user: ${message}` },           // Current message
      { text: 'MEDIA ANALYSIS:\n...' },       // Media description (if any)
      { inlineData: { mimeType, data } }      // Media image (if any)
    ]
    ```

18. **Gemini API Call**: Sends to Gemini with:
    - Model: `gemini-2.5-flash` or `gemini-2.5-pro`
    - Cached content: System prompt + KB routing
    - Tools: Lab calculation functions (if Pro tier)
    - User parts: Full context + current message

19. **Tool Execution** (if Gemini requests):
    - Gemini returns `functionCall` for lab calculations
    - Worker executes `calculateLabRatios()` locally
    - Worker sends result back to Gemini
    - Gemini generates final response with calculation results

20. **Response Parsing**: Extracts from Gemini response:
    - `text`: AI-generated response text
    - `model`: Model used (flash/pro)
    - `cachedTokens`: Tokens from cached content
    - `inputTokens`: Input tokens used
    - `outputTokens`: Output tokens generated
    - `latencyMs`: Response time

21. **Idempotency Check**: Saves state to Redis before sending:
    ```javascript
    const stateKey = `${tenantId}:state:${job.id}`
    await redis.set(stateKey, JSON.stringify({...}), 'NX', 'EX', 3600)
    ```
    - Prevents duplicate processing on retry
    - Allows fast-path retry recovery

#### Phase 7: Response Delivery (WhatsApp Layer)

22. **Send Lock Acquisition**: Claims exclusive send lock:
    ```javascript
    const sendClaim = await redis.set(sendStateKey, 'sending', 'NX', 'EX', 60)
    ```

23. **Message Chunking**: Splits response if > 4000 characters:
    ```javascript
    await sendChunked(waClient, from, text)
    ```

24. **Session Update**: Updates Redis with new conversation turn:
    ```javascript
    const updatedHistory = [...history,
      { role: 'user', content: message },
      { role: 'assistant', content: text }
    ]
    await redis.set(sessionKey, JSON.stringify(trimmed), 'EX', 3600)
    ```
    - Keeps system prompt + last 40 turns
    - Prevents context window overflow

25. **Send Confirmation**: Marks message as sent:
    ```javascript
    await redis.set(sendStateKey, 'sent', 'XX', 'EX', 3600)
    ```

#### Phase 8: Data Persistence (Database Layer)

26. **Profile Extraction**: Extracts patient facts from AI response:
    ```javascript
    const profileUpdate = extractProfileUpdate(text)
    // Returns: { age: 45, medications: ['metformin'], conditions: ['diabetes'] }
    ```

27. **Patient Upsert**: Updates patient profile in PostgreSQL:
    ```sql
    INSERT INTO patients (tenant_id, msisdn_hash, profile, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (tenant_id, msisdn_hash)
    DO UPDATE SET
      profile = patients.profile || $3,  -- Merge arrays
      updated_at = NOW()
    ```

28. **Chat Log Insert**: Records conversation for audit:
    ```sql
    INSERT INTO chat_logs (
      tenant_id, msisdn_hash, model,
      cached_tokens, input_tokens, output_tokens,
      latency_ms, depth_classification,
      retrieved_ids, cited_ids, citation_match,
      job_id, wa_message_id, created_at
    ) VALUES (...)
    ON CONFLICT (job_id) DO NOTHING  -- Idempotent
    ```

#### Phase 9: Error Handling (Safety Layer)

29. **On Worker Failure** (after all retries):
    - Sends safe-mode message to user
    - Logs escalation in PostgreSQL
    - Sends alert notification to operations team
    ```sql
    INSERT INTO escalations (tenant_id, msisdn_hash, reason, job_id, created_at)
    VALUES ($1, $2, 'job_failed_definitive', $3, NOW())
    ```

30. **On Gemini Unavailability**:
    - Uses cached safe-mode message from domain config
    - Logs specific error code for debugging
    - Continues to escalation workflow

### Key Design Patterns

| Pattern | Purpose | Implementation |
|---------|---------|----------------|
| **Idempotency** | Safe retry without side effects | Redis `NX` locks, SQL `ON CONFLICT` |
| **Circuit Breaker** | Fail fast when dependencies down | Cache readiness check at startup |
| **Graceful Degradation** | Continue service with reduced features | Flash model fallback, safe-mode messages |
| **Audit Trail** | Complete medical conversation history | Immutable chat_logs table |
| **Privacy by Design** | No raw phone numbers in logs | SHA-256 hashing of MSISDN |
| **Token Budgeting** | Control AI costs | MAX_KB_FILES, MAX_KB_CHARS caps |

## Safety & Reliability Features

- **Retry Logic**: BullMQ automatically retries failed jobs
- **Idempotency Gates**: Redis-based locks prevent duplicate operations
- **Graceful Degradation**: Safe-mode messages when services fail
- **Escalation Tracking**: Failed jobs logged for manual follow-up
- **Token Limits**: Capped KB file loading to control costs

## Development

### Linting

```bash
npm run lint
```

### Testing

```bash
npm test
```

## License

ISC
