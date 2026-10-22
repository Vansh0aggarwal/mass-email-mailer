# Swaniki New Business Radar — Stage 0 Migration Audit & Plan

## 1. Executive Summary & Repository Audit
The previous iteration of **Swaniki New Business Radar** (located in `..\new email project`) was built using:
- **Framework:** Next.js 15/16 with Turbopack and React 19.
- **Database & Auth:** Supabase PostgreSQL with Row Level Security (RLS) and Supabase Auth.
- **Data Flow:** Next.js Server Actions and SSR-coupled database calls.

The mandate is to transform the system into a **clean, production-oriented MERN stack** (MongoDB, Express, React, Node.js + TypeScript) adhering to:
- Strict multi-tenancy and organization-level data boundaries.
- Decoupled REST APIs under `/api/v1`.
- Single Page Application (SPA) architecture with React, Vite, React Router, TanStack Query, and Tailwind CSS.
- Dedicated AI provider adapters (with deterministic fallback and strict grounding).
- Provider-agnostic Email architecture (mock development provider first, safety pipeline before real dispatches).
- Standalone runnable architecture that does not require proprietary cloud databases like Supabase.

---

## 2. Inventory of Reusable Code & Business Logic

| Component / File | Original Location | Target Location in MERN | Reusability Strategy |
| :--- | :--- | :--- | :--- |
| **CSV Parser & Sanitization** | `modules/companies/services/csv-parser.service.ts` | `backend/src/services/csv-parser.service.ts` | **Direct reuse (95%)**: Formula injection sanitization (CWE-1236), rating normalization, header mapping, validation error summaries. |
| **Opportunity Scoring Engine** | `modules/services/services/opportunity-scoring.service.ts` | `backend/src/services/opportunity-scoring.service.ts` | **Direct reuse (95%)**: Multi-service recommendation logic, explicit need priority, confidence calculation, missing data warnings. |
| **AI Prompt Grounding & Anti-Hallucination** | `modules/ai/services/ai-prompt.service.ts` | `backend/src/providers/ai/ai-prompt.service.ts` | **Direct reuse (90%)**: Strict grounding rules, untrusted input wrapping, neutral fallback composition. |
| **AI Generation Service** | `modules/ai/services/ai-generation.service.ts` | `backend/src/providers/ai/ai-generation.service.ts` | **Ported**: Adapt provider calls (Gemini/OpenAI) with timeouts, deterministic fallback, token/cost estimation. |
| **Email Send Pipeline & Pre-flight Checks** | `modules/gmail/services/send-pipeline.service.ts` | `backend/src/services/email-send-pipeline.service.ts` | **Ported to Mongoose**: 7 pre-flight checks (authorization, approval status, mailbox health, pause switch, daily limits, suppression, idempotency locks). |
| **RBAC Matrix** | `modules/organizations/rbac.ts` | `backend/src/middleware/rbac.ts` & shared types | **Direct reuse**: Role hierarchies (`owner`, `admin`, `manager`, `sales_rep`, `viewer`) and permission checks. |
| **UI Components & Layout** | `modules/ai/components/*`, pages | `frontend/src/features/*` | **Migrated to Vite/React**: Replace Next.js primitives (`Link`, `useRouter`, Server Actions) with React Router, TanStack Query, and Axios/Fetch clients. |

---

## 3. Breaking Changes & Architectural Shifts

1. **Database Layer (Supabase PostgreSQL -> MongoDB / Mongoose)**
   - *PostgreSQL RLS* is replaced with explicit tenant-filtering Mongoose queries and Express middleware (`req.organizationId`).
   - Every collection includes `{ organization_id: ObjectId }` with compound indexes: `[ { organization_id: 1, ... } ]` to guarantee tenant isolation.
   - IDs transition from UUID strings to MongoDB `ObjectId` (or hex strings).

2. **Backend API Layer (Server Actions -> Express REST `/api/v1`)**
   - All server actions are converted to structured, Zod-validated REST endpoints with HTTP standard statuses (`200 OK`, `201 Created`, `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict`, `429 Too Many Requests`).
   - Unified API response wrapper `{ success: true, data: ... }` or `{ success: false, error: { code, message, details } }`.

3. **Frontend Runtime (Next.js SSR -> Vite + React SPA)**
   - Client-side routing powered by React Router v6.
   - Server state caching and invalidation powered by `@tanstack/react-query`.
   - Forms validated client-side with `react-hook-form` + `zod`.

4. **Authentication Architecture (Supabase Auth -> Development Mode / Modular Boundary)**
   - In accordance with Section 4, Google Auth and Gmail OAuth are deferred.
   - Dev-mode headers / mock authentication (`X-Tenant-Id`, `X-User-Id`, or cookie session) provide organization context, role verification, and user attribution without exposing production secrets.

---

## 4. Planned Phased Roadmap
- **Stage 0:** Repository audit & migration specification.
- **Stage 1:** MERN foundation (Root workspaces, Express backend, Vite frontend, MongoDB connection, logging, error handling, health checks).
- **Stage 2:** Companies and CSV import system (Mongoose models, parser, column mapping, duplicate detection, CRUD).
- **Stage 3:** Services & transparent recommendation engine (Catalog management, multi-criteria scoring, evidence explanation, templates).
- **Stage 4:** AI Email Studio (Adapter interface, prompt grounding, deterministic fallback, structured drafting).
- **Stage 5:** 3-panel Email Workspace (Mock email provider, threads, message list, detail viewer, composition, search).
- **Stage 6:** Sending safety & pre-flight pipeline (Idempotency locks, suppression list, daily limits, audit logging).
- **Stage 7:** Follow-ups & analytics (Scheduled follow-ups, outreach metrics, activity logs).
- **Stage 8:** Production readiness & verification (Test suites, typechecks, builds, documentation).
