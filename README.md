# Swaniki — New Business Radar

A multi-tenant B2B sales-intelligence workspace built as a MERN monorepo. It ingests prospect data (CSV), scores opportunities with a transparent rule engine, drafts outreach emails, and runs a real Gmail-connected email client — with a strict human-approval gate before anything is sent.

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
| **Theming** | Light / Dark / System with no flash, driven by one semantic token layer. |

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
  │          drafts · mailboxes · follow-ups · analytics · health
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
npm run test         # vitest across workspaces (18 backend suites, 6 frontend suites)
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
| `EMAIL_PROVIDER` | `mock` | `mock` \| `gmail` \| `smtp` |
| `EMAIL_DAILY_SEND_LIMIT` | `100` | Per-mailbox quota |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Required for real Google sign-in |
| `GOOGLE_AUTH_REDIRECT_URI` | `…/auth/google/callback` | |
| `GOOGLE_GMAIL_REDIRECT_URI` | `…/integrations/google/gmail/callback` | Separate Gmail (decoupled from login) |

Google setup walkthrough: [docs/google-oauth-gmail-setup.md](docs/google-oauth-gmail-setup.md).

---

## 8. Project structure

```
backend/
  src/
    routes/        REST endpoints (companies, imports, campaigns, drafts, mailboxes, …)
    services/      csv-parser · template-interpolation · campaign · opportunity-scoring
                   email-send-pipeline · google-oauth · mailbox-cleanup · campaign-scheduler
    providers/
      ai/          ai-grounding.service.ts · gemini.provider · openai.provider
      email/       email-provider.interface · gmail.provider · mock-email.provider
    middleware/    session · tenantContext · rateLimiter · errorHandler
    models/        Mongoose schemas (all organization-scoped; Campaign + CampaignRecipient)
    worker.ts      Dedicated persistent background scheduler process
    __tests__/     18 integration suites (175 tests)
frontend/
  src/
    pages/         20 routes (Dashboard, Email Workspace, AI Studio, Campaigns, …)
    components/    layout · mail · auth · common · shared
    context/       AuthContext · ThemeContext
    lib/           api · mail · email-html · theme · campaign
    index.css      single semantic design-token layer
    __tests__/     6 test suites (53 tests)
docs/              architecture · api · setup · google setup · theming · migration
```

---

## 9. Testing

```bash
npm run test --workspace=backend     # 175 tests / 18 suites
npm run test --workspace=frontend    # 53 tests / 6 suites
```

Backend suites exercise the real HTTP layer with `supertest` against a MongoDB instance, covering auth/logout cleanup, Gmail multi-mailbox, attachments/MIME, send pipeline, CSV import, campaigns (create → generate → approve → batched send → progress, idempotency and suppression), campaign recipient lifecycle diagnostics & retry, the durable scheduler (window/pacing/atomic-claim + reply association), AI providers (mocked HTTP retries/parsing + deterministic fallback), scoring, drafts and analytics. Frontend tests cover theme logic, email HTML sanitization/`cid:` handling, the avatar component, mailbox status helpers, campaign diagnostics and recipient masking/formatting helpers.

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
- **SMTP provider** is declared in configuration schema but currently defaults to Gmail and mock providers.

---

## License

UNLICENSED — internal / private project.
