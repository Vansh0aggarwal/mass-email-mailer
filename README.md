# Swaniki — New Business Radar

A multi-tenant B2B sales-intelligence workspace built as a MERN monorepo. It ingests prospect data (CSV), scores opportunities with a transparent rule engine, drafts outreach emails, and runs a real Gmail-connected email client — with a strict human-approval gate before anything is sent. A built-in productivity workspace (To-Do, Daily Tasks, projects, sticky notes) lives directly on the dashboard as floating windows and syncs with Google Tasks and Google Calendar — adding Google Meet links when a meeting is requested.

**Stack:** React 18 + Vite + TypeScript · Node + Express + TypeScript · MongoDB / Mongoose · npm workspaces.

---

## 1. What this project actually does

| Capability | What it does |
| --- | --- |
| **Auth & sessions** | Real Google OAuth 2.0 sign-in (OpenID), a signed JWT session cookie with server-side revocation, sign-out with optional mail-data purge. Dev-login fallback for local use. |
| **Companies & contacts** | Multi-tenant CRM records with compound indexes, suppression list, assessments and per-company notes. |
| **CSV imports** | Upload → inspect headers → map columns → preview/validate → commit. Built for the real 22-column Swaniki campaign file (~2,900 rows / ~6 MB, UTF-8 BOM, quoted multiline bodies, duplicate work emails): a real RFC-4180 parser + exact header aliasing auto-detect the columns, and in-file vs database duplicates are handled with `skip` / `update` (fill-empty-only). Defends against CSV/formula injection, interprets supplied website-audit metadata cautiously (never invents "no website"), records per-row errors, and preserves extra columns as bounded `customFields`. Missing optional cells are warned, not rejected. File/row caps are configurable (`JSON_BODY_LIMIT`, `IMPORT_MAX_FILE_BYTES`, `IMPORT_MAX_ROWS`) and return structured `413`s. |
| **Campaigns (CSV bulk sender)** | Import a CSV and launch a multi-step campaign: map columns (incl. custom ones), compose `{{token}}`-personalized steps with follow-up delays, batch-generate drafts, review/approve, then batch-send every message through the same 7-check + idempotency pipeline. Resumable without a queue. |
| **AI campaign generation** | Set `generationMode: 'ai'` to have the AI provider personalize each company/step (grounded on company + CSV custom fields, budget-guarded, deterministic fallback). Default remains deterministic `template` mode. |
| **Campaign scheduling** | Durable, restart-safe scheduling: `POST /campaigns/:id/schedule` with start time, timezone, batch size, pacing, and an optional local sending window. A background Mongo-polling worker sends approved recipients in paced batches and recovers after downtime — no Redis/queue required. |
| **Smart inbox & reply tracking** | Genuine inbound replies are auto-associated to the originating campaign recipient (and stop further follow-ups). Manual association is available, plus an AI reply assistant that drafts an editable, thread-grounded reply. |
| **Opportunity engine** | Deterministic weighted scoring (explicit needs 60 · assessment 25 · freshness 15) producing a score, confidence, evidence citations, qualification flag and a pitch summary. |
| **AI Email Studio** | Draft composer with tone presets, grounded context, and a human review/approve step. See the AI honesty section below. |
| **Email workspace** | 3-pane client (mailboxes → message list → conversation + context panel) backed by **real Gmail API** sync, send, reply, label/star/archive/trash, attachments and inline images. |
| **Send safety pipeline** | 7 pre-flight checks + idempotency lock before any outbound message. |
| **Follow-ups & analytics** | Touchpoint tasks (auto-cancelled when a reply arrives) and funnel/overview reporting. |
| **Productivity dashboard** | One primary dashboard with floating windows (blurred backdrop, nested dialogs, focus trap, mobile bottom sheets). Includes a today-only To-Do list with a persisted custom name and progress, a Daily Tasks workspace (Tasks · Projects · Notes · Upcoming · Completed tabs) — both backed by the same shared task records — project tracking with live progress, and Apple-Sticky-Notes-style boards with reordering. No separate productivity routes — every feature opens in place without changing the URL. |
| **Google Tasks & Calendar sync** | OAuth 2.0 connection with server-side encrypted tokens. Two-way Google Tasks sync (create/update/complete/delete with duplicate protection and a last-writer-wins conflict policy) plus optional calendar time blocks using each task's start/end time (30-minute default) and on-request Google Meet conference links with duplicate-safe event reuse. Incremental sync-token pulls and automatic recovery from expired tokens keep both sides consistent. Local saves never block on Google failures; sync errors are surfaced honestly. |
| **Reminders, notifications & search** | Opt-in browser reminders with per-task timing, overdue and integration alerts, and global search across companies, contacts, campaigns, inbox threads, tasks, projects, and notes. |
| **Theming** | Light / Dark / System with no flash, driven by one semantic token layer. |

> **Single-dashboard rule:** productivity intentionally has no dedicated pages. Opening To-Do, Daily Tasks, projects, notes, or integrations keeps you on `/dashboard`; the windows own their internal tab state and never change the URL.

---

## 2. AI maturity — exactly where this stands

This is important and stated plainly: **the AI layer is deliberately "deterministic-first", not a live LLM integration.** The app is designed so that a model provider can be dropped in without changing any product surface, but today the copy comes from a template engine.

| Area | Current level | Detail |
| --- | --- | --- |
| **Email drafting** | Deterministic templates | `AiGroundingService.generateEmailDraft()` always returns copy from `generateDeterministicFallback()`. It picks a professional structure from the tone + service and fills verified facts. |
| **External LLM call** | Real when configured | `AI_PROVIDER` defaults to `mock` (no provider → deterministic fallback). Set `AI_PROVIDER=gemini` or `openai` with the matching API key and real HTTPS calls are made (`gemini.provider` / `openai.provider`). Responses are strict-JSON validated; failures, timeouts, or an exhausted `AI_DAILY_CALL_LIMIT` transparently fall back to the deterministic engine and are flagged `isFallback`. |
| **Grounding / anti-hallucination** | Real, rule-based | Context is assembled only from stored fields (name, domain, industry, rating, declared needs, role, CSV custom fields). Every draft returns `factsUsed`, `missingInformation` and `warnings`; unrecorded data is flagged, never invented. |
| **Opportunity scoring** | Real, deterministic | A transparent weighted rule engine with evidence citations — not ML, not embeddings. |
| **Embeddings / RAG / vector search** | Not present | No vector store, no semantic search, no model fine-tuning. |

**Bottom line:** the LLM seam is real and wired (Gemini/OpenAI) but **off by default** — with no provider/key you get a transparent, auditable deterministic engine, and every AI result is either verified JSON from the provider or an explicitly flagged fallback. The value it delivers today is real (real Gmail, real scoring, real send pipeline, durable scheduling, reply tracking); the "AI" is honest about when it is and isn't a live model.

To make it a true LLM integration you would implement the HTTP call inside the `else` branch of `generateEmailDraft` (or add a provider class), keep the existing output schema (`GeneratedEmailOutput`) and fallback, and leave the rest of the app untouched.

---

## 3. Real vs simulated (no invented functionality)

| Feature | Status |
| --- | --- |
| Google sign-in | **Real** (requires Google Cloud OAuth credentials) |
| Gmail connect / sync / send / labels / attachments | **Real** (requires Gmail scope + credentials) |
| Dev-login (local) | Real, but a local-only convenience |
| Email sending when `EMAIL_PROVIDER=mock` | **Simulated** in-memory provider for dev/tests |
| AI email generation | **Deterministic template engine** (LLM call stubbed) |
| Opportunity scoring, CSV import, follow-ups, analytics | **Real** (fully implemented) |
| Productivity data (tasks, projects, notes, list settings) | **Real** (MongoDB-backed, per-user within the organization) |
| Google Tasks / Calendar sync | **Real** (requires a connected Google account with Tasks + Calendar scopes) |
| Browser task reminders | **Real**, opt-in only. Uses the Notification API and only fires while a Swaniki tab is open. |
| Dashboard productivity metrics | **Real** — sourced from `/api/v1/productivity/summary`; no placeholder numbers |
| Session revocation | In-memory denylist — correct for a single instance, needs Redis/Mongo to scale horizontally |

The UI never fabricates metrics: empty states are honest ("No campaigns yet", "No draft approvals recorded yet") and unavailable integrations say so.

---

## 4. Architecture

```
Frontend (React + Vite, :5173)
        │  fetch /api/v1  (cookies / Bearer)
        ▼
Express API (:5000)
  ├─ helmet · cors · rate-limit · cookie-parser
  ├─ tenantContext middleware (verifies session, resolves org/user/role)
  ├─ routes: auth · integrations/google/gmail · companies · contacts
  │          imports · campaigns · services · opportunities · templates
  │          drafts · mailboxes · follow-ups · analytics · search
  │          todos · projects · notes · productivity · calendar · health
  └─ services / providers
       ├─ AiGroundingService          (real provider + deterministic fallback)
       ├─ gemini/openAiProvider       (real HTTPS when AI_PROVIDER + key set)
       ├─ CampaignService             (batch draft-gen + batch send, resumable)
       ├─ CampaignSchedulerService    (durable Mongo-polling worker)
       ├─ ReplyAssistantService       (thread-grounded AI reply drafts)
       ├─ ReplyAssociationService     (reply → recipient/campaign linking)
       ├─ TemplateInterpolationService ({{token}} merge, bounded + header-safe)
       ├─ OpportunityScoringService   (weighted rule engine)
       ├─ EmailSendPipelineService   (7 checks + idempotency)
       ├─ ProductivitySyncService     (Task push + two-way pull/conflict policy)
       ├─ GoogleTasksService          (Google Tasks API v1)
       ├─ GoogleCalendarService       (Calendar v3 events + sync tokens)
       ├─ GmailProvider             (real Gmail API)   ← mailbox.provider === 'gmail'
       └─ MockEmailProvider         (dev default)
        ▼
MongoDB (every doc scoped by organizationId, compound indexes)
```

Session middleware is the source of truth for tenant identity. In non-production it falls back to seeded dev user/org headers so the API and tests run without Google credentials.

---

## 5. Security & multi-tenancy

- **Tenant isolation:** every query is scoped by `organizationId`; compound indexes (`{organizationId, ...}`) prevent cross-tenant reads.
- **Sessions:** a stateless signed JWT stored in an httpOnly / secure / `sameSite=lax` cookie. `requireAuth` guards protected routes and `requireSession` (which ignores the dev fallback) gates sensitive account actions; a server-side denylist revokes sessions on sign-out. Each session carries an org role (`owner` / `admin` / `manager` / `sales_rep` / `viewer`).
- **Token storage:** Google access/refresh tokens are encrypted at rest with AES-256-GCM via `utils/crypto.ts`; tokens are never returned in responses or logged.
- **Productivity isolation:** To-Do, Daily Tasks, projects, notes, and productivity search routes are guarded by `requireAuth`; records are scoped to the acting user within the organization, and Google account documents are org- and user-scoped. Integration responses strip token fields.
- **Send safeguards:** approval-required drafts, suppression list, mailbox pause switch, daily quota, RFC-compliant header sanitization (CRLF injection defense), idempotency lock on `organizationId + idempotencyKey`.
- **Input hygiene:** Zod schemas on every mutating route; CSV formula-injection defense on import.
- **Headers:** `helmet`, strict CORS allow-list, global + per-route rate limiting (strict limiter on AI endpoints).

---

## 6. Getting started

### Prerequisites
- Node.js 18+
- MongoDB (local, Atlas, or rely on the built-in in-memory fallback in dev/test)

### Install & run
```bash
npm install          # installs both workspaces
npm run dev          # backend (:5000) + frontend (:5173) together
```
Open http://localhost:5173. Use **Continue as Dev User** for instant local login, or configure Google OAuth (below) for real sign-in.

### Other scripts
```bash
npm run dev:backend
npm run dev:frontend
npm run build        # tsc + vite build for both workspaces
npm run typecheck    # tsc --noEmit across workspaces
npm run test         # vitest across workspaces (42 backend suites, 14 frontend suites)
npm run worker       # runs standalone persistent campaign scheduler worker (backend/src/worker.ts)
```

---

## 7. Environment variables (`backend/.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` disables the in-memory DB fallback |
| `PORT` | `5000` | |
| `CLIENT_URL` / `FRONTEND_URL` | `http://localhost:5173` | CORS + OAuth redirect targets |
| `MONGODB_URI` | `mongodb://localhost:27017/swaniki_radar` | Falls back to in-memory Mongo in dev/test |
| `MONGODB_URI_TEST` | derived `<db>_test` | Test runs always target a sibling test database so a suite cleanup can never delete workspace data |
| `JWT_SECRET`, `SESSION_SECRET` | dev defaults | **Set strong values in production** |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | dev default | 32-byte key for AES token encryption |
| `AI_PROVIDER` | `mock` | `gemini` \| `openai` \| `mock` (no provider → deterministic fallback) |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | — | Required to make real provider calls for the matching `AI_PROVIDER` |
| `AI_MODEL` | `gemini-1.5-flash` | Model id (OpenAI falls back to `gpt-4o-mini` for non-gpt names) |
| `AI_REQUEST_TIMEOUT_MS` | `20000` | Per-attempt timeout; transient errors retried with backoff |
| `AI_MAX_RETRIES` | `2` | Retries after the first AI call attempt |
| `AI_MAX_OUTPUT_TOKENS` | `1200` | Output cap per generation |
| `AI_TEMPERATURE` | `0.6` | Sampling temperature |
| `AI_DAILY_CALL_LIMIT` | `500` | Process-local daily real-call budget; beyond it → fallback |
| `CAMPAIGN_SCHEDULER_ENABLED` | `true` | Enables the durable campaign scheduler worker |
| `CAMPAIGN_SCHEDULER_INTERVAL_MS` | `60000` | Scheduler poll interval (min 5000) |
| `MAX_UPLOAD_SIZE_MB` | `2048` | Max spreadsheet upload (2 GB); `IMPORT_MAX_FILE_BYTES` overrides when set |
| `UPLOAD_CHUNK_SIZE_MB` | `8` | Resumable chunk size (server clamps to 256 KB–64 MB) |
| `CSV_IMPORT_BATCH_SIZE` | `2000` | Contact rows validated/staged per split-analysis batch |
| `CAMPAIGN_CREATION_BATCH_SIZE` | `10` | Child campaigns generated per batch |
| `CAMPAIGN_CREATION_CONCURRENCY` | `1` | Concurrent campaign workers (keep at 1 for strict ordering/quotas) |
| `CAMPAIGN_CREATION_MAX_RETRIES` | `3` | Retries for one transient child-campaign failure |
| `CAMPAIGN_SPLIT_DEFAULT_CONTACTS_PER_CAMPAIGN` | `100` | Preselected batch size in the splitter |
| `IMPORT_UPLOAD_DIR` | OS temp dir | **Use a persistent volume** in production (uploads/error reports) |
| `EMAIL_PROVIDER` | `mock` | `mock` \| `gmail` \| `smtp` |
| `EMAIL_DAILY_SEND_LIMIT` | `100` | Per-mailbox quota |
| `EMAIL_BRAND_NAME` / `_TAGLINE` / `_WEBSITE` | `Swaniki` / `New Business Radar` / `https://swaniki.dev` | Identity rendered into every designed email |
| `EMAIL_BRAND_CONTACT_EMAIL` / `_PHONE` / `_ADDRESS` | `hello@swaniki.dev` / — / — | Optional; empty values are omitted from the signature, never faked |
| `EMAIL_BRAND_CTA_URL` | — | Default CTA destination for presets; falls back to `EMAIL_BRAND_WEBSITE` |
| `EMAIL_UNSUBSCRIBE_URL` | — | Public unsubscribe endpoint appended to designed emails |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | — | Custom SMTP transport; all three required for `smtp` mailboxes |
| `SMTP_PORT` / `SMTP_SECURE` / `SMTP_FROM_NAME` | `587` / `false` / brand name | `secure=true` for implicit TLS (465); STARTTLS is required otherwise |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Required for real Google sign-in |
| `GOOGLE_AUTH_REDIRECT_URI` | `…/auth/google/callback` | |
| `GOOGLE_GMAIL_REDIRECT_URI` | `…/integrations/google/gmail/callback` | Separate Gmail (decoupled from login) |

Google Tasks + Calendar sync reuses the same `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` pair — no extra variables. The dashboard connect flow (`GET /api/v1/calendar/google/connect`) requests the `tasks` and `calendar.events` scopes and stores the resulting tokens encrypted server-side. Productivity data remains fully local when no Google account is connected.

Google setup walkthrough: [docs/google-oauth-gmail-setup.md](docs/google-oauth-gmail-setup.md).

### Large uploads and the Smart Campaign Splitter

- The splitter streams the uploaded file from disk (`IMPORT_UPLOAD_DIR`), validates rows in configurable batches, stages validated contacts in MongoDB (`CampaignStagingContact`), and then creates child campaigns in bounded batches. No full CSV or campaign array is held in Node memory.
- Uploads above 10 MB automatically use resumable 8 MB chunks (`POST /api/v1/campaign-splits/upload/init`, `PUT …/chunk`, `POST …/complete`). Failed chunks retry with backoff and completed chunks are skipped on resume.
- Reverse proxies/CDNs must allow the same size: raise nginx `client_max_body_size` (e.g. `2048m`), and any hosting body limit (Render/Vercel/Cloudflare) for the backend origin. Vercel's serverless body limit applies only to proxied requests; chunked requests stay below it.
- Mount a persistent volume at `IMPORT_UPLOAD_DIR`. Uploads and rejected-contact reports are referenced by path and must survive restarts for retry/resume.
- Generation is restart-safe: jobs resume on boot (`recoverInterruptedJobs`), allocation checkpoints and campaign/recipient upserts make retries idempotent. Child campaigns are always created as `draft`; nothing is scheduled or sent.
- Recipient integrity is an application feature, not an operational script. On the split detail page, **Check recipients** compares each child campaign with the durable staging rows (`GET /api/v1/campaign-splits/:id/recipients/integrity`); **Restore missing** recreates only the recipients that are absent and reconciles `stats.totalRecipients` (`POST /api/v1/campaign-splits/:id/recipients/repair`). It is idempotent, organization-scoped, never deletes recipients, and never recreates campaigns an operator deleted.

### Enterprise Email Design Studio

The studio composes premium, card-based HTML email that is safe to send from Gmail or custom SMTP. It lives at `/email-studio` in the app and is backed by `/api/v1/email-studio`.

**How it fits together**

```
frontend/src/pages/EmailDesignStudioPage.tsx      composer, approval + send controls
frontend/src/components/email-studio/DesignCardEditor.tsx   per-card editor
frontend/src/components/email-studio/EmailPreviewPanel.tsx  HTML / plain-text / device preview
frontend/src/lib/email-studio.ts                  types, API client, local validation
        │  POST /email-studio/preview | personalize | drafts | send
backend/src/email-design/types.ts                 Zod EmailDesignDocument + truthfulness guards
backend/src/email-design/render.ts                table-based inline-CSS HTML + text alternative
backend/src/email-design/brand.ts                 brand identity from env
backend/src/email-design/presets.ts               code-defined starting layouts
backend/src/services/email-studio.service.ts      draft lifecycle, grounded copy, approval gate
backend/src/routes/email-studio.ts                authenticated REST surface
backend/src/models/EmailStudioTemplate.ts         saved templates (organization-scoped)
```

1. The operator picks a preset or saved template, edits every card, and pastes the real conversation.
2. `POST /email-studio/preview` renders the **exact** HTML that will be stored and sent — the iframe shows a server render, not a client mockup.
3. `POST /email-studio/personalize` writes only greeting/paragraphs/bullets/(CTA copy). The AI prompt forbids figures that are not present in the operator's conversation or metrics; any output containing an unsupported statistic is discarded and replaced by deterministic, statistic-free copy.
4. `POST /email-studio/drafts` persists the design, rendered HTML and text. Status stays `draft`.
5. `POST /email-studio/drafts/:id/approve` is the human gate. It re-validates the design (CTA present, every metric has a value **and** a source) and records `approved`.
6. `POST /email-studio/send` re-renders from the approved design, then runs the existing send pipeline: mailbox ownership, suppression list, daily/hourly quota, idempotency (`EmailSendAttempt`), retries and delivery-error capture. Editing a draft reopens approval.

**Guarantees**

- No JavaScript, external stylesheet or remote font is emitted; HTML is semantic tables with inline CSS, MSO conditional comments, a dark-mode media query and a plain-text MIME alternative.
- All interpolated values are HTML-escaped. Variables: `{{company_name}}`, `{{recipient_name}}`, `{{sender_name}}`, `{{sender_title}}`, `{{service}}`.
- Metrics are operator-only. A metrics card without a source blocks preview, approval and send; the AI never writes metrics.
- Secrets (SMTP password, Gmail tokens) stay in the environment and are never returned by an API.

**Run locally**

```bash
cp backend/.env.example backend/.env   # optional: defaults work in dev
npm run dev                            # backend :5000 + frontend :5173
```

Open http://localhost:5173/email-studio. With `EMAIL_PROVIDER=mock` the mailbox sends are simulated end-to-end (`delivered to provider`, quota counters update) without leaving the machine. To send real email, connect Gmail under Integrations, or set `EMAIL_PROVIDER=smtp` plus the `SMTP_*` variables.

**Deploy to production**

1. Set `NODE_ENV=production`, `MONGODB_URI`, and strong `JWT_SECRET` / `SESSION_SECRET` / `OAUTH_TOKEN_ENCRYPTION_KEY`.
2. Set `EMAIL_BRAND_*` and `EMAIL_UNSUBSCRIBE_URL` to real values — the renderer omits empty identity fields rather than inventing them.
3. Gmail: create an OAuth client with the Gmail send scope and set `GOOGLE_GMAIL_REDIRECT_URI` to the public backend URL. SMTP: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`.
4. Publish SPF, DKIM and DMARC DNS records for the sending domain (`v=spf1 include:… -all`, provider DKIM selector, `v=DMARC1; p=quarantine; rua=mailto:…`). Start DMARC at `p=none` while collecting reports, then tighten.
5. Serve the API behind TLS and set `CLIENT_URL` to the public frontend origin for CORS and OAuth returns.
6. Monitor `EmailSendAttempt` (status, `attempts`, `errorMessage`, `deliveryUncertain`). The shared delivery layer records bounces as suppressions and blocks suppressed recipients before dispatch; unsubscribe links should point at a handler that adds the address to the suppression list.

---

## 8. Project structure

```
backend/
  src/
    routes/        REST endpoints (companies, imports, campaigns, drafts, mailboxes,
                   todos, projects, notes, productivity, calendar, search, …)
    services/      csv-parser · template-interpolation · campaign · opportunity-scoring
                   email-send-pipeline · email-studio · google-oauth · mailbox-cleanup
                   campaign-scheduler · google-tasks · google-calendar · productivity-sync
    email-design/  types (Zod design document + send guards) · render · brand · presets
    providers/
      ai/          ai-grounding.service.ts · gemini.provider · openai.provider
      email/       email-provider.interface · gmail.provider · smtp.provider · mock-email.provider
    middleware/    session · tenantContext · rateLimiter · errorHandler
    models/        Mongoose schemas (all organization-scoped; Campaign + CampaignRecipient,
                   TodoItem, TodoList, Project, StickyNote, CalendarAccount, EmailStudioTemplate)
    worker.ts      Dedicated persistent background scheduler process
    __tests__/     41 integration suites
frontend/
  src/
    pages/         22 page modules (Dashboard, Email Workspace, AI Studio, Design Studio, …)
    components/    layout · mail · auth · common · shared · productivity · email-studio
                   (floating windows, To-Do, Daily Tasks, Projects, Notes, integration)
    context/       AuthContext · ThemeContext · ProductivityContext
    hooks/         useDebouncedValue
    lib/           api · mail · email-html · email-studio · theme · campaign · productivity
    index.css      single semantic design-token layer
                   (13 colocated *.test.* suites)
docs/              architecture · api · setup · google setup · theming · migration
```

---

## 9. Testing

```bash
npm run test --workspace=backend     # 387 tests / 42 suites (6 skipped)
npm run test --workspace=frontend    # 124 tests / 14 suites
```

Backend tests derive a `<database>_test` database from `MONGODB_URI` (override with `MONGODB_URI_TEST`), so running the suite never touches workspace data.

Backend suites exercise the real HTTP layer with `supertest` against a MongoDB instance, covering auth/logout cleanup, Gmail multi-mailbox, attachments/MIME, send pipeline, CSV import, campaigns (create → generate → approve → batched send → progress, idempotency and suppression), campaign recipient lifecycle diagnostics & retry, the durable scheduler (window/pacing/atomic-claim + reply association), AI providers (mocked HTTP retries/parsing + deterministic fallback), scoring, drafts, analytics, and the productivity APIs (one shared task store behind both To-Do and Daily views, today filtering and list settings, time ranges and reminders, manual Meet-link validation, projects with live progress, sticky-note reordering, summary/notifications/search, and Google sync error paths). The email-design studio suite covers rendering (tables, no scripts/external CSS, escaped variables, plain-text alternative), metric-source blocking, AI statistic rejection, draft → approval → send idempotency and organization isolation.

Frontend tests cover theme logic, email HTML sanitization/`cid:` handling, the avatar component, mailbox status helpers, campaign diagnostics, recipient masking/formatting helpers, the right-rail layout contract, the bottom-navigation route contract, floating-window presets and viewport clamping, and the custom cursor.

---

## 10. Documentation

- [System architecture](docs/architecture.md)
- [REST API reference](docs/api.md)
- [Setup & runbook](docs/setup.md)
- [Google OAuth + Gmail setup](docs/google-oauth-gmail-setup.md)
- [Theming & design tokens](docs/theme.md)
- [Migration plan](docs/migration-plan.md)

---

## 11. Known limitations / roadmap

- **Session denylist is in-memory** — fine for single instance / dev / testing; configure Redis/Mongo collection for distributed horizontal web tier.
- **Real Google + Gmail flows** require user-provided Google Cloud project credentials (client id, secret, and approved scopes); dev-login and mock email provider are active out of the box.
- **Google Tasks / Calendar sync** additionally requires the connected Google account to grant the `tasks` and `calendar.events` scopes. Conflicts are resolved last-writer-wins (a locally dirtied task is pushed; otherwise the newer remote version is applied).
- **Browser reminders** rely on the Notification API and a 60-second in-page check, so they only fire while a Swaniki tab is open — there is no service worker or push backend yet.
- **SMTP provider** is declared in configuration schema but currently defaults to Gmail and mock providers.

---

## License

UNLICENSED — internal / private project.
