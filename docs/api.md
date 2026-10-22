# Swaniki New Business Radar — REST API Reference (`/api/v1`)

All endpoints require tenant scoping via `x-organization-id` header (defaults to dev mock tenant if omitted).

---

## 1. System & Health
### `GET /api/v1/health`
Returns system status, MongoDB connectivity, memory footprint, and configured providers.

---

## 2. Companies & Contacts
### `GET /api/v1/companies`
- **Query Params:** `q` (search), `industry`, `rating`, `page`, `limit`.
- **Response:** Paginated list of company profiles.

### `POST /api/v1/companies`
- **Body:** `{ name, domain, websiteUrl, industry, city, country, overallRating, notes, services }`
- **Response:** Created company record.

### `GET /api/v1/companies/:id`
- Returns company details, associated contacts, and historical assessments.

### `GET /api/v1/contacts`
- **Query Params:** `q`, `companyId`.

### `PATCH /api/v1/contacts/:id/suppress`
- **Body:** `{ isSuppressed: boolean, reason?: string }`

---

## 3. CSV Imports
All import endpoints require an authenticated tenant (`requireAuth`).

### `POST /api/v1/imports/inspect`
- Parses the uploaded CSV with a real RFC-4180 parser (quoted fields, embedded commas/newlines, escaped quotes, UTF-8 BOM) and returns detected headers and a best-effort mapping for the real Swaniki 22-column campaign file.
- **Body:** `{ csvContent: string, fileName?: string }`
- **Response:** `{ fileName, byteLength, rowCount, headers, detectedMapping, unmappedHeaders, missingRequiredFields, sampleRows, parseErrors, limits: { maxFileBytes, maxRows } }`
- Enforces the configured file/row limits (see below) and returns `413` (`FILE_TOO_LARGE` / `TOO_MANY_ROWS`) when exceeded.

### `POST /api/v1/imports/preview`
- Validates + normalizes rows (Formula Injection sanitization, rating normalization, email syntax, website-audit interpretation) and runs **in-file and database** deduplication. Nothing is written.
- **Body:** `{ csvContent: string, mapping: ColumnMapping, customFieldMapping?: Record<string,string>, scaleType?: 'standard'|'five_star'|'ten_point' }`
- **Response `summary`:** `{ totalRows, validRows, errorRows, duplicateRows, existingRows, fileDuplicateRows, missingOptionalRows, websiteAuditWarningRows, parsedRows }`

### `POST /api/v1/imports/commit`
- Commits validated rows into `Company`, `CompanyContact`, and `CompanyAssessment`. Extended fields and `customFieldMapping` columns are stored as bounded `Company.customFields`.
- **Body:** `{ fileName, rows: ParsedCsvRow[], mapping, customFieldMapping?, duplicateStrategy?: 'skip'|'update' }`
- `duplicateStrategy` defaults to `skip`. `update` only fills empty fields on the existing tenant record — it never overwrites populated data — and is idempotent.
- Idempotent and tenant-scoped; large files can be committed in row batches.

### `GET /api/v1/imports`
- Returns past import executions and row error summaries for the tenant.

**Upload limits (env):** `JSON_BODY_LIMIT` (default `30mb`), `IMPORT_MAX_FILE_BYTES` (default `10737418240`), `IMPORT_MAX_ROWS` (default `10000000`), `IMPORT_CHUNK_SIZE_BYTES` (default `10485760`), `IMPORT_BATCH_SIZE` (default `500`), `IMPORT_WRITE_CONCURRENCY` (default `2`).

**Website-audit safety:** a timeout or HTTP error is never treated as proof of a missing website. `definitiveNoWebsite` is only true when `Website Status = Missing` **and** `Site Audit Type = Unregistered`; all other inconclusive audits produce cautious warnings.

---

## 4. Services & Opportunities
### `GET /api/v1/services`
- Lists available business services catalog (auto-seeds defaults if empty).

### `GET /api/v1/opportunities`
- Evaluates algorithmic recommendations for all active companies.
- **Response:** Ranked array of recommendations with evidence citations, confidence score, and pitch summaries.

---

## 4b. Campaigns (CSV bulk sender)
### `POST /api/v1/campaigns/preview`
- Parses a CSV and returns `{ headers, sampleRows, totalRows }` for the column-mapping wizard.

### `POST /api/v1/campaigns/upload`
- Direct streaming multipart upload for **CSV and XLSX**. The file is streamed to disk and inspected (headers, sample rows, exact/estimated row count) without loading it into memory.
- **Body:** `multipart/form-data` with a `file` field.
- **Response:** `{ uploadId, fileName, fileType, fileSize, headers, sampleRows, totalRows, totalRowsIsExact, delimiter }`
- XLSX files are read with a shared-strings-aware streaming reader, so cells that reference the shared string table resolve to their real text (a plain CSV parser sees `[object Object]` for those cells).
- Companion endpoints: `POST /api/v1/campaigns/upload/init` (resumable chunked upload), `PUT /api/v1/campaigns/upload/:uploadId` (chunk), `GET /api/v1/campaigns/upload/:uploadId/status`, `POST /api/v1/campaigns/upload/:uploadId/complete`, `DELETE /api/v1/campaigns/upload/:uploadId`.

### `POST /api/v1/campaigns`
- Creates a campaign from a CSV: persists companies/contacts (`customFields` = bounded extra columns) and one recipient per valid row.
- **Body:** `{ name, mailboxId, steps: [{ subject, bodyText, delayDays? }], csvContent, columnMapping, customFieldMapping?, senderName?, generationMode?: 'template'|'ai', targetService? }`
- `generationMode` defaults to `template` (deterministic `{{token}}` merge). When set to `ai`, draft generation calls the configured AI provider per company/step and transparently falls back to the deterministic engine (drafts carry `isFallbackTemplate`).
- **Response:** `{ campaignId, importId, summary, warnings }`

### `GET /api/v1/campaigns` / `GET /api/v1/campaigns/:id`
- List / fetch campaigns with `stats` (recipients, prepared, sent, failed, skipped).
- `sent` is the count of **successful message sends** (one per accepted step send, derived from durable `EmailSendAttempt` records), not the number of recipients. A recipient with Step 1 sent but Steps 2/3 still approved still contributes its sent step to the count. The metric is refresh-stable and dedupe-safe.

### `POST /api/v1/campaigns/:id/generate`
- Batched, resumable draft generation. In `template` mode uses `{{token}}` interpolation (built-ins + custom columns); in `ai` mode calls the AI provider per company (budget-guarded, with deterministic fallback on failure).
- **Body:** `{ batchSize?: number, senderName?: string }` → `{ processed, remaining, status, stats }`

### `GET /api/v1/campaigns/:id/recipients`
- Paginated review queue; each recipient includes its per-step drafts.
- Each step draft may carry `companyNameMismatch`: set when the interpolated/generated copy names a company that does not match the recipient. It is surfaced as a warning for human review; already-sent messages are never silently rewritten.

### `PATCH /api/v1/campaigns/:id/recipients/:recipientId/steps/:stepIndex`
- Edits a not-yet-sent step draft. **Body:** `{ subject, bodyText }`

### Recipient table "Target Topic"
- The `Target Topic` column renders the CSV `Proposed Deliverable` custom field. When blank, the UI shows `Target topic not provided` plus an optional AI recommendation (clearly labelled). Supporting evidence (Sector, Website Status, Site Audit Type, HTTP Code, Page Title, Primary Tech Signal) is available in the expandable "Why are we targeting this company?" row.

### `POST /api/v1/campaigns/:id/approve`
- Approves generated drafts (all, or `{ recipientIds }`).

### `POST /api/v1/campaigns/:id/send`
- Batched, resumable send. Every message passes through the same 7-check pipeline and idempotency lock.
- **Body:** `{ mailboxId?, batchSize?: number }` → `{ processed, remaining, status, stats, throttledAccounts? }`
- `throttledAccounts[]` lists the mailboxes that did not send because their daily or hourly cap is reached; their recipients stay queued.
- If the mailbox has exhausted its Gmail API quota budget, the step is **deferred, not failed**: the attempt row records `status: 'deferred'` with `deferredUntil`, the draft stays `approved` (`canRetry: true`), and the API returns `429` `GMAIL_QUOTA_EXCEEDED` with `{ deferred: true, deferredUntil }`. The same deterministic idempotency key resumes the send once the budget refills, so no duplicate message is ever produced.

### `POST /api/v1/campaigns/:id/schedule`
- Registers a **durable, restart-safe** schedule. A background worker (started in `server.ts`, no frontend timers) sends approved recipients in paced batches and recovers missed work after downtime.
- Requires at least one approved recipient.
- **Body:** `{ startAt: ISO string, timezone?: string, batchSize?: number (1-200), paceMinutes?: number (0-1440), windowStartHour?: number, windowEndHour?: number, label?: string }`
- Window hours are interpreted in `timezone`; omit both for "any time". A cross-midnight window (e.g. 22→06) is supported.
- **Response:** `{ campaignId, status: 'scheduled', schedule, approvedRecipients }`

### `POST /api/v1/campaigns/:id/resume`
- Resumes a `paused` campaign: back to `scheduled` if it has a schedule, else to `ready_for_review` for manual batched sending.

### `POST /api/v1/campaigns/:id/cancel`
- Cancels a scheduled/paused/sending campaign and marks it finished (sets `lastError`).

### `POST /api/v1/campaigns/:id/recipients/:recipientId/associate-reply`
- Manually links an inbox thread to a campaign recipient when automatic matching is not confident.
- **Body:** `{ threadId: string }`

### `GET /api/v1/campaigns/:id/progress` · `POST /api/v1/campaigns/:id/pause` · `DELETE /api/v1/campaigns/:id`
- `progress` includes `byStatus`, `repliesReceived`, `schedule`, and `lastError`.

---

## 4c. Multi-mailbox campaigns (drip mailing)

A campaign can send from several connected Gmail accounts at once. Every recipient is
assigned to **exactly one** mailbox and is always contacted from that mailbox, so a
thread never moves between inboxes. A campaign without a roster keeps the classic
single-`mailboxId` behaviour.

### `GET /api/v1/campaigns/sender-accounts`
- Lists every connected account of the organization that may act as a campaign sender.
- **Response:** `[{ accountId, emailAddress, displayName, provider, status, authorized, authorization: { reason?, reasonCode? }, dailySendLimit, sendsToday, reservedSends, remainingDailyAllowance, sendsThisHour, quota }]`
- An account is **not authorized** when it is disconnected, paused, in an error state, missing a refresh token or missing the `gmail.modify` scope. Such an account is never used for a send and never silently replaced.

### `GET /api/v1/campaigns/:id/sender-accounts`
- The campaign's roster plus the live per-account queue state.
- **Response:** `{ roster: CampaignSenderAccount[], accounts: SenderQueueAccount[], legacyMailboxId }`
- `accounts[]` carries the live numbers: `waiting`, `sent`, `sendsToday`, `sendsThisHour`, `reservedSends`, `effectiveDailyCap`, `effectiveMaxPerHour`, `nextSendAt`, `ready` and a machine readable `reasonCode` (`DAILY_LIMIT_REACHED`, `HOURLY_LIMIT_REACHED`, `INTERVAL_NOT_ELAPSED`, `NO_READY_RECIPIENT`, `ACCOUNT_DISCONNECTED`, …).

### `PUT /api/v1/campaigns/:id/sender-accounts`
- Replaces the campaign's sender roster. Only accounts of the organization are accepted; a not-authorized account is rejected with `409 SENDER_ACCOUNT_NOT_AUTHORIZED` instead of being dropped.
- **Body:** `{ accounts: [{ accountId, enabled?, dailySendCap?, maxPerHour?, minIntervalSeconds?, jitterSeconds? }] }`
- Counters of the previous roster (`assignedCount`, `sentCount`, `lastSentAt`, …) are preserved.

### `POST /api/v1/campaigns/:id/sender-accounts/allocate`
- Spreads the campaign's recipients over the roster: duplicates are skipped first, the least loaded enabled account wins, ties break on the account id (100 recipients over 3 accounts → 34/33/33).
- Existing assignments are never moved. `redistribute: true` recomputes the assignment, but only while nothing was ever sent — afterwards the assignments are frozen.
- **Body:** `{ redistribute?: boolean }`
- **Response:** `{ campaignId, eligibleRecipients, assignedRecipients, newlyAssigned, duplicatesSkipped, orphaned, migrated, assignmentsFrozen, lockedRecipients, accounts[] }`

### `POST /api/v1/campaigns/:id/sender-accounts/rebalance`
- Moves recipients that never received a message to a less loaded mailbox. **Owner/admin only** (`403 REBALANCE_FORBIDDEN`).
- **Body:** `{ fromAccountId?, toAccountId?, balance?: boolean }`

### `POST /api/v1/campaigns/:id/sender-accounts/:accountId/toggle`
- Enables or disables one mailbox of the campaign. A disabled mailbox keeps its recipients but never sends.
- **Body:** `{ enabled: boolean }`

### Multi-mailbox behaviour of the existing endpoints
- `POST /api/v1/campaigns` and `POST /api/v1/campaigns/jobs` accept `senderAccountIds: string[]`. With two or more ids the recipients are allocated over the roster right after the import; a single id keeps the classic behaviour.
- `POST /api/v1/campaigns/:id/schedule` accepts the drip pacing: `minIntervalSeconds`, `jitterSeconds`, `maxPerHour`, `dailySendCap` and `allowedWeekdays` (0 = Sunday … 6 = Saturday). The values are the default for every mailbox of the roster; a mailbox with its own limits keeps them.
- `POST /api/v1/campaigns/:id/send` sends every recipient from **its own** assigned mailbox. It honours the daily and hourly caps of that mailbox (a mailbox that hit its cap keeps its recipients queued and is listed in `throttledAccounts`), but it intentionally ignores the drip interval so an operator can flush a batch.
- `POST /api/v1/campaigns/:id/cancel` sets the status to `cancelled` and invalidates every unsent step, so a worker that is already running can no longer send.

---

## 5. AI Email Studio & Drafts
### `POST /api/v1/drafts/generate`
- Generates grounded email draft with anti-hallucination rules.
- **Body:** `{ companyName, recipientEmail, recipientName, targetService, tone, objective }`

### `GET /api/v1/drafts`
- Lists drafts filtered by `status` (`draft`, `approved`, `accepted`, etc.).

### `PUT /api/v1/drafts/:id`
- Human review and content editing.

### `POST /api/v1/drafts/:id/approve`
- Explicit human approval transition (`draft` -> `approved`).

### `POST /api/v1/drafts/reply-assistant`
- Generates an editable AI reply draft grounded on the actual inbox thread + company context. Never invents pricing, availability, or commitments; unknowns are surfaced as `questionsForUser`.
- **Body:** `{ mailboxEmail, threadId, fromEmail, incomingMessage, recipientName?, companyName?, targetService?, action?: 'generate'|'shorter'|'detailed'|'change_tone'|'answer_question'|'next_step'|'clarify', instruction?, tone?, senderName? }`
- Rate-limited by `strictAiRateLimiter`. Falls back deterministically when no provider/key is configured.

---

## 6. Mailbox & Sending Safety
### `GET /api/v1/mailboxes`
- Returns mailboxes and connection status.

### `GET /api/v1/mailboxes/:id/threads`
- 3-panel middle message list with unread state, search, and snippets.

### `POST /api/v1/mailboxes/:id/threads/:threadId/reply`
- Appends user reply message to conversation thread.

### `POST /api/v1/mailboxes/:id/send`
- Executes 7 pre-flight safety checks and dispatches via provider adapter.
- **Body:** `{ draftId: string, idempotencyKey: string }`

---

## 6b. Gmail Integration & API Quota Control
Google's Gmail API enforces a hard ceiling of **6,000 quota units per minute per Google user**. Every Gmail call in the backend (including OAuth profile lookups and background inbox sync) is metered through a per-mailbox token bucket, so a burst of campaign sends can never exhaust the real quota.

### `GET /api/v1/integrations/google/gmail/connect`
- Starts the Google OAuth flow for a separate mailbox connection (distinct from sign-in).

### `GET /api/v1/integrations/google/gmail/callback`
- OAuth callback. The final `users.getProfile` call is metered against the newly connected mailbox.

### `POST /api/v1/integrations/google/gmail/:emailAddress/disconnect`
- Revokes the stored refresh token, invalidates the cached Gmail client, and releases the mailbox's quota/lease state.

### `POST /api/v1/integrations/google/gmail/:emailAddress/sync`
- Runs a manual inbox sync. Sync is budget-aware: it waits at most `GMAIL_SYNC_MAX_WAIT_MS` for quota and then defers the remaining work to the next tick instead of failing.
- **Response:** `{ mailboxEmail, synced, deferred, reason? }`

### `GET /api/v1/integrations/google/gmail/:emailAddress/quota`
- Rate-controller observability for one mailbox.
- **Response:** `{ emailAddress, quota: { tokens, capacity, refillPerSecond, rateFactor, totalUnitsReserved } | null, projectQuota: { projectKey, tokens, capacity, refillPerSecond, rateFactor, totalUnitsReserved } | null, metrics: { totalCalls, successCalls, failedCalls, quotaErrors, retries, deferredCalls, waitMs, unitsConsumed, byMethod, lastQuotaErrorAt } | null }`
- `quota.tokens` is the **live** budget (stored tokens plus everything refilled since the last call).
- `projectQuota` is the **shared daily budget of the Google Cloud project**. Google's daily sending quota is granted per project, not per mailbox: connecting more Gmail accounts does not raise the ceiling, all mailboxes of a project spend from the same budget.

**Quota semantics (env):**
- `GMAIL_QUOTA_UNITS_PER_MINUTE` (default `6000`) — the published per-user ceiling the controller plans against.
- `GMAIL_QUOTA_SAFETY_FACTOR` (default `0.8`) — fraction of that ceiling the scheduler may use, leaving headroom for interactive work.
- `GMAIL_QUOTA_BURST_UNITS` (default `600`) — maximum instantaneous burst for a single mailbox.
- `GMAIL_MAX_CONCURRENT_CALLS` (default `4`) — concurrent Gmail calls per mailbox, enforced by a shared lease so multiple workers cannot exceed it.
- `GMAIL_MAX_RETRIES` / `GMAIL_RETRY_BASE_DELAY_MS` / `GMAIL_RETRY_MAX_DELAY_MS` — retry policy for 429/5xx/network failures (exponential backoff with jitter).
- `GMAIL_PROJECT_DAILY_QUOTA_UNITS` (default `1000000`) — capacity of the shared project bucket.
- `GMAIL_PROJECT_QUOTA_SAFETY_FACTOR` (default `0.9`) — fraction of the project budget the scheduler may spend.
- The controller adapts: repeated quota errors shrink the sustained rate, sustained success restores it.
- A quota error penalises **both** the mailbox bucket and the project bucket.

**Send deferral:** when a mailbox has no budget left, a send is **deferred, not failed**. The attempt row records `status: 'deferred'` and `deferredUntil`, the draft stays `approved` with `canRetry: true`, and the API returns `429` `GMAIL_QUOTA_EXCEEDED` with `{ deferred: true, deferredUntil }`. The same deterministic idempotency key (`campaign_<campaignId>_<recipientId>_step<stepIndex>_manual`) resumes the send once the budget refills, so a deferred step never produces a duplicate message.

**Method costs (units):** `messages.send` 100 · `threads.get.full` 120 · `threads.list` 10 · `history.list` 2 · `messages.list` 5 · `messages.attachments.get` 20 · `threads.modify` 10 · `threads.trash` 20 · `threads.delete` 20 · `users.getProfile` 1.

---

## 7. Follow-ups & Analytics
### `GET /api/v1/follow-ups` / `POST /api/v1/follow-ups` / `PATCH /api/v1/follow-ups/:id`
- Follow-up task scheduling and completion tracking.

### `GET /api/v1/analytics/overview`
- Aggregates tracked companies, contacts, suppression counts, draft approvals, and dispatch attempts.
