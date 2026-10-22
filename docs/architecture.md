# Swaniki New Business Radar — Complete System Architecture & Specification

Swaniki New Business Radar is an enterprise-grade, multi-tenant B2B sales intelligence, prospect management, CSV outreach, and AI-assisted email automation platform built on the MERN stack.

---

## 1. System Topology & High-Level Architecture

The platform is structured as a TypeScript monorepo comprising a modern React 18 Single-Page Application (SPA) and an Express REST API backed by MongoDB.

```mermaid
flowchart TD
    subgraph ClientLayer["Frontend Client (React 18 + Vite + Tailwind)"]
        UI["Web UI Components & Views"]
        RQ["TanStack React Query (Cache & State)"]
        SSEClient["SSE Stream Consumer & Polling Fallback"]
        LocalStorage["Client Storage (Session & Job Reconnect)"]
    end

    subgraph GatewayLayer["API Gateway & Middleware Layer (Express)"]
        SecMiddleware["Helmet, CORS & Rate Limiter"]
        TenantMW["tenantContext & requireAuth Middleware"]
        SessionCrypto["Signed JWT Cookie & Session Denylist"]
    end

    subgraph CoreServices["Domain Services & Engine Layer"]
        ImportSvc["ImportJobService\n(Streaming CSV, Batching & SSE)"]
        CampaignSvc["CampaignService\n(Batch Draft Gen & Batch Send)"]
        SchedulerSvc["CampaignSchedulerService\n(Durable Poller & Window Pacer)"]
        PipelineSvc["EmailSendPipelineService\n(7 Pre-Flight Checks & Idempotency)"]
        AiSvc["AiGroundingService\n(Anti-Hallucination & Fallback)"]
        ReplySvc["ReplyAssociationService\n(Inbound Matching & Auto-Cancel)"]
        GmailSvc["GmailProvider & Decoupled Sync Engine"]
    end

    subgraph DataStorage["Storage & Persistence Layer"]
        Mongo[("MongoDB Multi-Tenant Database\n(Compound tenant indexes)")]
        DiskStaging[("Ephemeral Upload Staging\n(/uploads/imports)")]
    end

    subgraph ExternalServices["External APIs & Integrations"]
        GoogleOAuth["Google Cloud Identity (OAuth 2.0 / OpenID)"]
        GmailAPI["Google Gmail REST API (v1)"]
        LLMProviders["Google Gemini / OpenAI REST APIs"]
    end

    UI -->|"HTTP Requests (JSON / Multipart)"| SecMiddleware
    SSEClient -->|"Server-Sent Events (/jobs/:id/stream)"| GatewayLayer
    SecMiddleware --> TenantMW
    TenantMW --> SessionCrypto
    SessionCrypto --> CoreServices

    ImportSvc -->|"Stream inspect & read"| DiskStaging
    ImportSvc -->|"Emit progress events"| SSEClient
    ImportSvc -->|"Batch upserts"| Mongo

    CampaignSvc --> PipelineSvc
    SchedulerSvc --> PipelineSvc
    PipelineSvc -->|"Real dispatch"| GmailSvc
    GmailSvc -->|"Decoupled API calls"| GmailAPI
    GmailSvc -->|"Inbound emails"| ReplySvc
    ReplySvc -->|"Cancel follow-ups & mark replied"| Mongo

    AiSvc -->|"Grounding facts & guardrails"| LLMProviders
    CoreServices --> Mongo
    GatewayLayer --> GoogleOAuth
```

---

## 2. Multi-Tenant Security, Session & Token Cryptography

### 2.1 Multi-Tenant Isolation
Every persistent document carries `organizationId`. Compound database indexes enforce tenant isolation at the query execution level:
- `{ organizationId: 1, name: 1 }`
- `{ organizationId: 1, email: 1 }`
- `{ organizationId: 1, idempotencyKey: 1 }`
- `{ organizationId: 1, status: 1 }`

### 2.2 Token Encryption at Rest
All third-party OAuth access and refresh tokens are encrypted at rest using **AES-256-GCM** with unique initialization vectors (IV) and authentication tags:

```mermaid
flowchart LR
    PlainToken["Plain OAuth Refresh Token"] -->|"AES-256-GCM Encrypt (Server Secret + Random IV)"| EncryptedPayload["Ciphertext + IV + Auth Tag"]
    EncryptedPayload -->|"Persist in DB"| MailboxDoc[("Mailbox Document\n(encryptedRefreshToken)")]
    MailboxDoc -->|"AES-256-GCM Decrypt (Verify Auth Tag)"| DecryptedToken["Decrypted Token\n(Never logged or exposed in API)"]
```

### 2.3 Spreadsheet Injection Defense (CWE-1236)
All imported CSV cells are sanitized on ingest. Any string beginning with `=`, `+`, `-`, `@`, `\t`, or `\r` is automatically prefixed with a single quote (`'`) to prevent formula execution in spreadsheet software.

---

## 3. Real-Time Streaming CSV Ingestion & Progress Architecture

The CSV import pipeline handles large outreach files (up to thousands of rows) without exhausting server memory or timing out.

```mermaid
sequenceDiagram
    autonumber
    actor User as User Browser
    participant Gateway as API Gateway (/api/v1/imports)
    participant Staging as Disk Storage (/uploads/imports)
    participant JobSvc as ImportJobService
    participant EventBus as importJobEventEmitter
    participant DB as MongoDB (CSVImport, Company)

    User->>Gateway: POST /jobs (Multipart CSV File)
    Gateway->>Staging: Stream file to disk (Never fully buffered in RAM)
    Gateway->>JobSvc: inspectUploadedFile(path)
    JobSvc->>JobSvc: Stream inspect headers, count lines, auto-detect mapping
    JobSvc->>DB: Create CSVImport record (status: 'pending')
    Gateway-->>User: 201 Created (jobId, totalRows, sampleRows, detectedMapping)

    User->>User: Display CsvImportProgressModal
    User->>Gateway: GET /jobs/:id/stream (SSE connection)
    Gateway->>EventBus: Listen for "progress:jobId" events

    User->>Gateway: POST /jobs/:id/start (mapping, duplicateStrategy)
    Gateway-->>User: 202 Accepted (processing started in background)

    loop Process Bounded Batches (e.g. 500 rows per batch)
        JobSvc->>Staging: Read batch chunk from disk
        JobSvc->>JobSvc: Validate required fields & clean cells
        JobSvc->>DB: Bulk write Companies & Contacts (skip/update duplicates)
        JobSvc->>DB: Update CSVImport (processedRows, importedCount, duplicateRows, failedRows)
        JobSvc->>EventBus: emit("progress:jobId", { processedRows, percent, ... })
        EventBus-->>Gateway: SSE message event
        Gateway-->>User: Server-Sent Event (percent: "32.35%", counter: "647 of 2,000")
    end

    alt On Completion with Row Errors
        JobSvc->>Staging: Write errorReport.csv (RFC-4180 format)
        JobSvc->>DB: Mark status 'completed_with_errors'
        JobSvc->>EventBus: emit("progress:jobId", { status: 'completed_with_errors' })
        Gateway-->>User: SSE final event
        User->>Gateway: GET /jobs/:id/errors (Download Error CSV)
    else Clean Completion
        JobSvc->>DB: Mark status 'completed'
        JobSvc->>EventBus: emit("progress:jobId", { status: 'completed' })
    end
```

### Reconnection Resilience Flow
If the user navigates away or reloads the browser:
1. `localStorage.getItem('radar_active_import_job_id')` restores the active modal immediately.
2. `GET /api/v1/imports/active` checks the database for any running job for the tenant.
3. The modal reconnects to the SSE stream or falls back automatically to 800ms polling.

---

## 4. Multi-Step CSV Outreach & Draft Generation Architecture

Swaniki preserves three email sequence steps (`Step 1`, `Step 2`, `Step 3`) from the prospect dataset, personalizing each contact's message before human approval.

```mermaid
flowchart TD
    subgraph CSVSource["Imported CSV Dataset"]
        Col1["Step 1 Subject & Body"]
        Col2["Step 2 Subject & Body"]
        Col3["Step 3 Subject & Body"]
        Col4["Company Name, Work Email, Custom Fields"]
    end

    subgraph PreservationLayer["Preservation & Contact Storage"]
        CSVImportDoc["CSVImport Document"]
        CompanyDoc["Company Document (customFields Map)"]
        ContactDoc["CompanyContact Document"]
    end

    subgraph CampaignPipeline["Campaign Recipient & Draft Generation"]
        CampRecip["CampaignRecipient Record\n(email, companyId)"]
        InterpSvc["TemplateInterpolationService\n({{token}} replacement & CRLF sanitization)"]
        Draft1["EmailDraft: Step 1 (prepared)"]
        Draft2["EmailDraft: Step 2 (prepared, follow-up delay)"]
        Draft3["EmailDraft: Step 3 (prepared, follow-up delay)"]
    end

    subgraph HumanApproval["Human Review & Approval Gate"]
        UIReview["Campaign Recipient Detail UI"]
        EditDraft["Inline Subject & Body Editor"]
        ApproveAction["POST /recipients/:id/approve"]
        ApprovedState["EmailDraft status: 'approved'"]
    end

    CSVSource --> PreservationLayer
    PreservationLayer --> CampRecip
    CampRecip --> InterpSvc
    InterpSvc --> Draft1
    InterpSvc --> Draft2
    InterpSvc --> Draft3
    Draft1 --> UIReview
    Draft2 --> UIReview
    Draft3 --> UIReview
    UIReview --> EditDraft
    EditDraft --> ApproveAction
    ApproveAction --> ApprovedState
```

---

## 5. Send Safety Pipeline & 7 Pre-Flight Verification Checks

No email leaves the system without passing through all seven verification layers and obtaining an atomic idempotency lock.

```mermaid
sequenceDiagram
    autonumber
    participant Client as Campaign Dispatcher / User
    participant Pipeline as EmailSendPipelineService
    participant Lock as Idempotency Engine
    participant DB as MongoDB
    participant Mailbox as Mailbox Manager
    participant Provider as Gmail / SMTP Provider

    Client->>Pipeline: executeSend(draftId, mailboxId, idempotencyKey)

    Note over Pipeline: Check 1: Authorization
    Pipeline->>DB: Verify draft belongs to authenticated organizationId

    Note over Pipeline: Check 2: Idempotency Lock
    Pipeline->>Lock: Acquire lock on { organizationId, idempotencyKey }
    alt Lock already exists / Send completed
        Lock-->>Pipeline: Lock duplicate detected
        Pipeline-->>Client: Return previously recorded SendResult (No duplicate dispatch)
    end

    Note over Pipeline: Check 3: Draft Status Check
    Pipeline->>DB: Ensure draft.status === 'approved' (Reject if prepared or draft)

    Note over Pipeline: Check 4: Recipient Email Validation
    Pipeline->>Pipeline: Validate RFC-5322 format & domain MX readiness

    Note over Pipeline: Check 5: Suppression List Verification
    Pipeline->>DB: Check if recipient email or domain is on tenant opt-out list

    Note over Pipeline: Check 6: Mailbox Operational & Pause Switch
    Pipeline->>Mailbox: Verify mailbox active, tokens valid, emergency pause OFF

    Note over Pipeline: Check 7: Daily Quota Verification
    Pipeline->>Mailbox: Verify sendsToday < dailyQuota (e.g. 500/day)

    Pipeline->>Provider: sendEmail(mimeMessage, threadHeaders)
    Provider-->>Pipeline: Provider Message ID & Thread ID
    Pipeline->>DB: Record SentEmail & update CampaignRecipient stats
    Pipeline->>Mailbox: Increment sendsToday counter
    Pipeline->>Lock: Release lock with success payload
    Pipeline-->>Client: Dispatch Confirmed (accepted)
```

---

## 5b. Gmail API Quota Control (Per-Mailbox Token Bucket)

Google enforces **6,000 quota units per minute per Google user** on the Gmail API. A campaign that sends a few hundred messages can exhaust that ceiling on its own, so every Gmail call — sends, thread reads, history polls, attachment fetches, and even the OAuth `getProfile` call — passes through a shared, per-mailbox rate controller.

```mermaid
flowchart LR
    Caller["Campaign Scheduler / Sync Worker / OAuth Callback"] --> Metered["gmailCall()\nSingle metered entry point"]
    Metered --> Quota["GmailQuotaService\nToken bucket (Mongo)"]
    Quota -->|"no budget"| Defer["Defer\n(status: deferred)"]
    Quota -->|"budget reserved"| Lease["GmailApiLease\nConcurrency slots (TTL)"]
    Lease --> Exec["gmail.users.* call"]
    Exec -->|"429 / 5xx"| Backoff["Backoff + retry\n(AIMD rate adaptation)"]
    Exec -->|"success"| Metrics["GmailApiMetrics\n(calls, units, wait time)"]
```

**Mechanics**
- **Token bucket** (`GmailQuotaLedger`, one row per mailbox): a capacity of `GMAIL_QUOTA_UNITS_PER_MINUTE * GMAIL_QUOTA_SAFETY_FACTOR`, refilled continuously at `capacity / 60` units per second, with a burst allowance of `GMAIL_QUOTA_BURST_UNITS`. Refill is applied both on reservation and when the live state is read, so a mailbox recovers automatically after an idle period.
- **Method cost table**: each Gmail method has a published unit cost (`messages.send` 100, `threads.get.full` 120, `threads.list` 10, `history.list` 2, `messages.list` 5, `messages.attachments.get` 20, `threads.modify`/`trash`/`delete` 10-20, `users.getProfile` 1). The cost is reserved *before* the call, so an expensive read can never be started without budget.
- **Concurrency leases** (`GmailApiLease`): at most `GMAIL_MAX_CONCURRENT_CALLS` in-flight Gmail calls per mailbox, shared across scheduler, sync worker and API requests. Leases expire via TTL so a crashed worker cannot deadlock a mailbox.
- **AIMD adaptation**: repeated 429s shrink the sustained rate factor; sustained success restores it. The controller therefore converges on a rate the mailbox can actually sustain instead of repeatedly hitting the ceiling.
- **Deferral, not failure**: when the bucket is empty, the send is deferred (`status: 'deferred'`, `deferredUntil` set), the draft stays `approved` with `canRetry: true`, and the caller receives `429 GMAIL_QUOTA_EXCEEDED` with `{ deferred: true, deferredUntil }`. The identical idempotency key resumes the send once the budget refills, so a deferred step can never deliver twice.
- **Observability**: `GET /api/v1/integrations/google/gmail/:emailAddress/quota` exposes the live budget plus per-method call/unit counters, wait time, retry count, and the last quota error timestamp.

### 5c. Shared Project Quota (The Ceiling That Does Not Grow With Mailboxes)

The **daily** Gmail API quota is granted per **Google Cloud project**, not per mailbox.
Connecting five Gmail accounts to the same project does not create five budgets — it
creates five spenders on one budget. The platform therefore meters a second, shared
bucket next to the per-mailbox bucket:

| Bucket | Key | Purpose |
| --- | --- | --- |
| Mailbox | `user:<emailAddress>` | Per-user 6,000 units/minute ceiling, burst control, AIMD rate factor |
| Project | `project:<GOOGLE_CLIENT_ID>` | Shared daily budget of the whole Cloud project (`GMAIL_PROJECT_DAILY_QUOTA_UNITS`, `GMAIL_PROJECT_QUOTA_SAFETY_FACTOR`) |

- A quota error penalises **both** buckets, so a mailbox that keeps hitting the ceiling
  also slows the whole project down instead of starving the other mailboxes.
- `GET /api/v1/integrations/google/gmail/:emailAddress/quota` returns the shared bucket
  as `projectQuota`, which is the only reliable way to see how much of the daily budget
  is left.
- **Operational consequence:** adding mailboxes increases throughput only until the
  shared project budget is exhausted. The drip pacing (§5d) therefore spreads the
  available budget over time instead of spending it in a burst.

---

## 5d. Multi-Mailbox Drip Mailing (One Recipient, One Mailbox)

A campaign may send from several connected Gmail accounts. The unit of scheduling is
not the campaign but the **mailbox**: every mailbox owns a small logical queue and
sends at its own pace.

```mermaid
flowchart TD
    Roster["Campaign.senderAccounts\n(roster + per-mailbox limits)"]
    Alloc["SenderAllocationService\nbalanced, stable assignment"]
    Queue["SenderQueueService\nper-mailbox dispatch queue"]
    Idx["CampaignRecipient\nassignedAccountId / assignedAccountEmail\nassignmentLocked"]
    Guard["Slot reservation\n(sendsToday + reservedSends < cap)"]
    Pipe["EmailSendPipeline\n7 pre-flight checks"]
    Mail["Gmail API\nproject + mailbox quota"]

    Roster --> Alloc --> Idx
    Roster --> Queue
    Idx --> Queue
    Queue --> Guard --> Pipe --> Mail
    Mail -->|"accepted"| Idx
    Mail -->|"quota"| Backoff["Backoff 60s\nstep stays approved"]
    Backoff --> Queue
```

**Guarantees**

1. **One recipient, one mailbox.** The queue only ever looks at recipients whose
   `assignedAccountId` matches the account it dispatches for. A thread never moves
   between inboxes, and a follow-up is always sent from the mailbox that sent the
   first step. Once a step was really sent, the assignment is *locked*
   (`assignmentLocked`) and can never be migrated.
2. **Balanced and stable allocation.** Duplicate addresses are skipped first (one
   prospect is contacted at most once per campaign), then every remaining recipient
   goes to the least loaded enabled account; ties break on the account id, so 100
   recipients over 3 mailboxes yield 34 / 33 / 33. An existing assignment is never
   moved automatically. A redistribution is only possible while nothing was ever
   sent — afterwards the assignments are frozen.
3. **Drip pacing, no catch-up bursts.** A mailbox sends at most one message per
   `minIntervalSeconds + jitter`. A paused, throttled or quota-limited mailbox
   resumes at its configured rate; it never flushes the backlog in one burst.
4. **Atomic caps.** The daily and hourly caps are claimed with a conditional update
   on the account (`sendsToday + reservedSends < cap`), so two workers can never
   book the same slot. The reservation is released in a `finally` block, and the
   counters are only incremented once the provider accepted the message.
   A manual "send batch" skips the drip *interval* (the operator explicitly asked
   for a batch) but never the daily and hourly caps — otherwise a single click
   could send hundreds of messages in a second and get the mailbox throttled. The
   mailboxes that hit a cap report themselves in `throttledAccounts` and keep
   their recipients queued.
5. **Unavailable accounts are held, never substituted.** A disconnected, revoked or
   paused mailbox is reported as *not authorized*. Its recipients stay assigned and
   are **held back** (orphaned) instead of being silently sent from another inbox.
   Only an owner/admin may migrate them with an explicit rebalance.
6. **Transient is not broken.** A reached cap or a missing due recipient is a
   *transient* state: it is reported live by `GET /campaigns/:id/sender-accounts`
   (`reasonCode`) but is never persisted as `unavailableReason`, which stays
   reserved for a mailbox that really cannot send (disconnected, revoked, paused,
   missing scope). A stale marker of a former outage is removed as soon as the
   mailbox works again.
7. **Replies are mailbox aware.** The reply association prefers the recipient whose
   `assignedAccountEmail` matches the mailbox the reply arrived in, and records the
   mailbox on `replyMailboxEmail`.
8. **Cancellation is final.** Cancelling a campaign sets `status: 'cancelled'` and
   invalidates every unsent step, so a worker that is already running finds nothing
   to send.

**Per-mailbox limits**

| Setting | Scope | Default |
| --- | --- | --- |
| `dailySendCap` | sends per mailbox and day | `CAMPAIGN_SENDER_DAILY_CAP_DEFAULT` (100), ceiling `CAMPAIGN_SENDER_DAILY_CAP_MAX` (2000) |
| `maxPerHour` | sends per mailbox and hour | `CAMPAIGN_SENDER_MAX_PER_HOUR_DEFAULT` (60), ceiling `CAMPAIGN_SENDER_MAX_PER_HOUR_MAX` (1000) |
| `minIntervalSeconds` | spacing between two sends | `CAMPAIGN_SENDER_MIN_INTERVAL_SECONDS_DEFAULT` (60) |
| `jitterSeconds` | randomized extra spacing | `CAMPAIGN_SENDER_JITTER_SECONDS_DEFAULT` (30) |

The campaign schedule can carry the same values as **campaign-wide defaults**; a
mailbox whose limits were tuned explicitly keeps its own values.

**Legacy behaviour is preserved:** a campaign without a roster keeps using its single
`mailboxId` sender and the classic batched sending path.

---

## 6. Multi-Step Follow-Up Scheduling & State Machine

When `Step 1` is successfully sent, the system schedules `Step 2` automatically based on the configured delay. If an inbound reply is detected at any time, subsequent steps are permanently cancelled.

```mermaid
stateDiagram-v2
    [*] --> Prepared: Import CSV / Generate Drafts
    Prepared --> Approved: User Review & Approval
    Approved --> SendingStep1: Dispatch Triggered (Manual or Scheduled)

    state SendingStep1 {
        [*] --> Check7Guards
        Check7Guards --> DispatchGmail: All checks passed
    }

    SendingStep1 --> Step1Sent: 200 OK Accepted by Gmail
    SendingStep1 --> SendFailed: Pre-flight failure or API error
    SendFailed --> Approved: Retry Dispatch

    Step1Sent --> Step2Scheduled: Calculate scheduledAt (now + step2DelayDays)
    
    state Step2Scheduled {
        WaitingForTimer --> SendWindowVerification: Timer elapsed
        SendWindowVerification --> DispatchStep2: Inside sending window
    }

    Step2Scheduled --> Step2Sent: Step 2 Accepted by Gmail
    Step2Scheduled --> CancelledUponReply: Inbound reply detected from prospect

    Step2Sent --> Step3Scheduled: Calculate scheduledAt (now + step3DelayDays)
    Step3Scheduled --> Step3Sent: Step 3 Accepted by Gmail
    Step3Scheduled --> CancelledUponReply: Inbound reply detected from prospect

    Step3Sent --> CampaignCompleted: All sequence steps completed
    CancelledUponReply --> CampaignCompleted: Follow-ups safely suppressed
```

---

## 7. Decoupled Gmail Integration & Inbound Reply Association

```mermaid
flowchart TD
    subgraph GoogleCloud["Google Cloud / Gmail Service"]
        GmailMailbox["Gmail User Inbox (vansh321aggarwal@gmail.com)"]
        GmailPush["Gmail History API / Push Notifications"]
    end

    subgraph SyncWorker["Decoupled Sync Engine (Backend)"]
        HistoryPoller["Incremental History Poller (historyId cursor)"]
        FullSyncFallback["Full Sync Fallback (on 404 history expired)"]
        MessageFetcher["Message & RFC-822 MIME Fetcher"]
    end

    subgraph DatabaseLayer["Persistence & Reconciliation"]
        EmailThreadModel[("EmailThread Collection\n(threadId, snippet, subject)")]
        EmailMsgModel[("EmailMessage Collection\n(headers, bodyText, attachments)")]
        ReplyAssoc["ReplyAssociationService"]
        CampaignModel[("Campaign & CampaignRecipient\n(repliesReceived, status: 'replied')")]
        TaskModel[("FollowUpTask Collection")]
    end

    GmailPush --> HistoryPoller
    HistoryPoller -->|"Cursor expired"| FullSyncFallback
    HistoryPoller -->|"New message IDs"| MessageFetcher
    FullSyncFallback -->|"Baseline messages"| MessageFetcher
    MessageFetcher --> EmailThreadModel
    MessageFetcher --> EmailMsgModel

    EmailMsgModel -->|"Detect inbound message (isIncoming: true)"| ReplyAssoc
    ReplyAssoc -->|"Match sender email against active campaigns"| CampaignModel
    CampaignModel -->|"Mark recipient status = 'replied'"| CampaignModel
    CampaignModel -->|"Increment campaign.repliesReceived"| CampaignModel
    ReplyAssoc -->|"Cancel pending scheduled follow-ups"| TaskModel
```

---

## 8. Entity-Relationship Data Model (ERD)

```mermaid
erDiagram
    Organization ||--o{ User : "members"
    Organization ||--o{ Company : "owns"
    Organization ||--o{ Mailbox : "connects"
    Organization ||--o{ CSVImport : "uploads"
    Organization ||--o{ Campaign : "launches"
    Organization ||--o{ SuppressionItem : "suppresses"

    Company ||--o{ CompanyContact : "contacts"
    Company ||--o{ CompanyAssessment : "audits"
    Company ||--o{ FollowUpTask : "tasks"

    Campaign ||--o{ CampaignRecipient : "targets"
    CampaignRecipient ||--o{ EmailDraft : "step_drafts"
    CampaignRecipient ||--o{ EmailSendAttempt : "attempts"

    Mailbox ||--o{ EmailThread : "syncs"
    EmailThread ||--o{ EmailMessage : "messages"
    EmailMessage ||--o{ EmailAttachment : "attachments"

    Organization {
        string id PK
        string name
        string slug
        string plan
        date createdAt
    }

    Company {
        string id PK
        string organizationId FK
        string name
        string domain
        string websiteUrl
        string industry
        string overallRating
        map customFields
        boolean isArchived
    }

    CompanyContact {
        string id PK
        string organizationId FK
        string companyId FK
        string email
        string firstName
        string lastName
        boolean isPrimary
    }

    CSVImport {
        string id PK
        string organizationId FK
        string fileName
        string status
        int totalRows
        int processedRows
        int importedCount
        int duplicateRows
        int failedRows
        string errorReportPath
        map mapping
    }

    Campaign {
        string id PK
        string organizationId FK
        string name
        string status
        string mailboxId FK
        array senderAccounts
        int totalRecipients
        int sentCount
        int repliesReceived
        array steps
    }

    CampaignRecipient {
        string id PK
        string campaignId FK
        string companyId FK
        string email
        string status
        string assignedAccountId FK
        string assignedAccountEmail
        boolean assignmentLocked
        int currentStep
        date nextStepScheduledAt
        boolean hasReplied
    }

    EmailDraft {
        string id PK
        string organizationId FK
        string recipientId FK
        int stepIndex
        string subject
        string bodyText
        string status
        boolean isApproved
    }

    Mailbox {
        string id PK
        string organizationId FK
        string email
        string provider
        string encryptedRefreshToken
        int sendsToday
        int dailySendLimit
        boolean isPaused
        string historyId
    }
```

---

## 9. Fault Tolerance, Recovery & Reliability Summary

| System Component | Potential Failure Mode | Built-in Mitigation & Architecture Guarantee |
| :--- | :--- | :--- |
| **CSV Import Processing** | Network timeout during 10,000-row upload | File streams to disk in chunks; never stored in heap memory. Resumable via `/jobs/:id/retry`. |
| **Progress UI Tracking** | Browser closed or refreshed midway through import | State stored in MongoDB; client restores modal via `localStorage` and `GET /api/v1/imports/active`. |
| **Real-Time Streaming** | Client does not support SSE or proxy buffers events | Automatic fallback to bounded 800ms polling endpoint `GET /api/v1/imports/jobs/:id`. |
| **Outbound Email Sending** | User double-clicks "Send All" or network retries | Atomic idempotency lock on `{ organizationId, idempotencyKey }` guarantees exactly-once dispatch. |
| **Draft Approval Integrity** | Unapproved draft triggered by automated worker | Pre-Flight Check 3 strictly asserts `draft.status === 'approved'`; rejects with structured error. |
| **Follow-up Sequence** | Prospect replies after Step 1 is sent | Inbound reply association immediately marks recipient `replied` and cancels pending `Step 2`/`Step 3`. |
| **Gmail OAuth Token Expiry** | Expired refresh token or invalid grant | Automatic token refresh with exponential backoff; encrypted at rest via AES-256-GCM. |
| **Daily Sending Ceiling** | Mailboxes connected to one project share a single daily budget | Second shared project bucket meters all mailboxes of a project; a quota error penalises both buckets and the drip pacing spreads the budget over time. |
| **Duplicate Recipient** | Same address appears twice in a CSV | Allocation deduplicates by normalized address, so one prospect receives at most one message per campaign. |
| **Recipient Migrated Mid-Campaign** | A recipient is moved to another mailbox after a send | Assignments of contacted recipients are locked (`assignmentLocked`); redistribution is refused once anything was sent. |
| **Mailbox Unavailable** | Account disconnected, revoked or out of quota | The account is reported as not authorized, its recipients are held back instead of being silently sent from another inbox, and an owner/admin can migrate them explicitly. |
| **Two Workers Claim One Slot** | Scheduler and manual send race for the same hourly/daily budget | Slot reservation is a conditional atomic update (`sendsToday + reservedSends < cap`); the reservation is released in `finally`. |
| **Campaign Cancelled Mid-Flight** | A worker is already sending when the user cancels | Cancellation sets `status: 'cancelled'` and invalidates every unsent step, so the worker finds nothing left to send. |
