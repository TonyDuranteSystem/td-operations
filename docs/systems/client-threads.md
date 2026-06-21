# Client Threads
_Last verified against code: 2026-06-21 — Antonio + Claude (Phase 1 build)_

## What it is
A purpose-built tracking layer that links a **support conversation** to a **client**
(account | contact | lead) and a **topic**, so staff can pull up *"everything about
this client"* or *"everything on this topic"* — in Slack and in the CRM. The same
tagged record is the structured intake the Decision Memory "brain" will consume in a
later phase (per-client recall). It points at where a conversation lives (a Slack
thread now; portal chat / email / calls later) — it does **not** copy message content.

Origin: Antonio (#td-support, 2026-06-21). dev_task `54f89912`. Plan:
`~/.claude/plans/curried-imagining-zephyr.md`.

## Business rules
- **WHO** can be an account, a contact, **or a lead** (not only active clients).
  `account_id` + `contact_id` may co-exist (a contact who belongs to an account); a
  lead stands alone. At least one entity must be set (`num_nonnulls >= 1`).
- **Topic** is catalog-driven (no free text). Source of truth = the existing
  **`topic_templates`** catalog (banking, billing, closure, documents, formation,
  general, itin, lease, tax). New topics go through the catalog flow, never a raw string.
- **Auto-tag is low-stakes by design.** It writes to `client_threads` (NOT the trusted
  CRM `conversations` log), as `source_kind='auto'` + low confidence, correctable by
  re-tagging. It is **not** a system of record for billing/compliance.
- **Decision Memory feeding is deferred** (Phase 3) and will use **only human-confirmed**
  rows — auto rows must never be auto-mirrored into the semantic memory (poisoning risk).

## How it's built
- **Table:** `client_threads` (migration
  `scripts/migrations/20260621-1500-create-client-threads.sql`). Columns: nullable FKs
  `account_id`/`contact_id`/`lead_id` (+ CHECK at-least-one), `topic_slug`, `source`
  (`'slack'|'crm_log'|'portal'|'email'|'call'`), `source_ref`, `thread_id`, `status`
  (default `'open'`), `summary`, `source_kind` (`'auto'|'manual'`), `confidence`,
  `confirmed_by`/`confirmed_at`, timestamps. **Partial UNIQUE(`source`,`source_ref`)
  WHERE source_ref IS NOT NULL** = structural idempotency (one row per thread). **RLS
  enabled, no policies** → deny-all to anon/authed; only the service role touches it.
- **Capture (Slack worker):** `lib/ai-agent/worker-tools.ts` —
  `TAG_CLIENT_THREAD_TOOL` (write) + `tagClientThreadFromWorker`, `FIND_CLIENT_THREADS_TOOL`
  (read) + `findClientThreadsForWorker`. Gated by `CallWorkerOptions.enableClientThreadTag`
  (tag) / `enableClientThreadRead` (find), injected in `callWorker`, executor
  `availableNames` gate. **Kept OUT of `WORKER_TOOLS`** so the Hermes/Telegram research
  worker never gets them (R108). `lib/ai-agent/slack-claude.ts::processSlackEvent` sets
  `enableClientThreadTag` **only when `channelId === process.env.SLACK_SUPPORT_CHANNEL_ID`**
  and appends a prompt block instructing the worker to tag + reply "📌 Tagged … reply to change".
- **`source_ref` key:** `${channelId}:${threadTs}` from `_currentSlackCtx` (threadTs =
  `slack_thread_ts ?? slack_event_ts`, always set = the thread root).
- **Upsert:** race-safe insert → on `23505` update the existing row (the DB unique index,
  not app code, guarantees one row across the two Slack write paths).
- **Retrieval (CRM):** `app/(dashboard)/conversations/page.tsx` +
  `components/conversations/conversation-table.tsx` — global filterable view (client search,
  topic/source/status), staff-only (dashboard layout + `isDashboardUser`), reads via
  `supabaseAdmin` (RLS deny-all). Sidebar entry "Conversations" in
  `components/dashboard/sidebar.tsx`. **Per-page tabs on account/contact/lead = Phase 1b.**
- **Backfill:** `scripts/migrations/20260621-1510-backfill-client-threads-from-conversations.sql`
  — one-time, idempotent (`ON CONFLICT … DO NOTHING`), from `conversations` only.
- **Env:** `SLACK_SUPPORT_CHANNEL_ID` (Vercel; observed `C0BA802S9LH`). Unset ⇒ tagging OFF.

## Gotchas, invariants & past bugs
- **Topic vocabulary REUSES `topic_templates`** — do NOT create a separate `support_topics`
  catalog (would fragment). Validate `topic_slug` against `listEntries('topic_templates')`.
- **Do NOT extend the `conversations` table for live threads** (considered + rejected): it's
  the *finished-interaction* CRM log (status enum is a send-lifecycle), its readers are
  contact-only, and auto-writing guesses there is unsafe. `client_threads` is the home.
- **No backfill from `thread_summaries`** — the Slack worker creates them WITHOUT
  `accounts_affected`, so they carry no client link, and deriving a Slack `source_ref` from
  them risks colliding with live tags.
- **Idempotency lives in the DB** (partial unique index), not the app upsert — two Slack
  write paths (webhook direct + scan cron) would otherwise race.
- **R108:** the tag/find tools must stay out of `WORKER_TOOLS`; the executor `availableNames`
  gate is the defense-in-depth backstop. Regression-tested in
  `tests/unit/client-threads-worker.test.ts`.
- **Entity CHECK is at-least-one (`>= 1`), not exactly-one** — real data (and the
  conversations backfill) carries account_id + contact_id together.

## How to verify current state
- Schema: `SELECT column_name FROM information_schema.columns WHERE table_name='client_threads'`
  and `SELECT indexname FROM pg_indexes WHERE tablename='client_threads'` (expect the partial
  unique `client_threads_source_ref_uniq`).
- Gating invariant: `npx vitest run tests/unit/client-threads-worker.test.ts` (14 tests) and
  the `slack-claude-worker.test.ts` opts assertion (enableClientThreadRead/Tag).
- Capture wiring: grep `enableClientThreadTag` in `lib/ai-agent/slack-claude.ts` (must be
  gated on `isSupportChannel`).
- Production status: `client_threads` exists in SANDBOX only as of 2026-06-21; promote the two
  migration files + run `npm run gen:types` + set `SLACK_SUPPORT_CHANNEL_ID` on production
  promotion (Phase 1 not yet shipped to prod).

---

## Phase 2 — Slack client-conversation form (2026-06-21)

**Why:** Antonio works in Slack, not the CRM. He wants to start a client conversation *from Slack* — pick the client + topic from fields, talk to the worker — and have it recorded in the CRM (when/what/whom). The CRM is the record; Slack is where the work happens.

**Flow:** a pinned **"➕ New client conversation"** button in #td-support → `views.open` modal (client `external_select` live CRM search + topic `static_select` from `topic_templates`) → submit posts a labeled root message ("🗂️ Client · Topic") that starts the thread + writes a `client_threads` tag (`source_kind='manual'`, `confidence=1`, `confirmed_at`). In that thread the worker is grounded with the client+topic (`lookupClientThreadContext` by `source_ref`), and each worker exchange is logged to the CRM `conversations` table (`channel='Slack'`) via `recordClientThreadExchange` → readable in the account/contact Activity tab.

**Key files:** `lib/ai-agent/slack-claude.ts` (`parseSlackInteractionFull`, `openSlackModal`, `buildClientConversationButtonBlocks`, `buildClientConversationModalView`, `searchClientsForSlackOptions`, `createClientConversationFromModal`, `lookupClientThreadContext`, `recordClientThreadExchange` + action_id/callback constants); `app/api/webhooks/slack-interactions/route.ts` (block_actions / block_suggestion / view_submission — Stop path unchanged). Migration `20260621-1600-conversations-add-slack-channel.sql` (adds 'Slack' to `conversation_channel` enum). Tests: `tests/unit/client-conversation-form.test.ts`.

**Activation (one-time):** (1) prod enum: run `ALTER TYPE conversation_channel ADD VALUE IF NOT EXISTS 'Slack'`; (2) Slack app → Interactivity → **Options Load URL** = the `/api/webhooks/slack-interactions` route (Request URL already set); (3) post + pin the button in #td-support using `SLACK_BOT_TOKEN_CLAUDE` (must be the Claude app so clicks route to its interactivity endpoint — NOT the slack MCP app).

**Gotchas:** view_submission carries no channel → stashed in the modal's `private_metadata`. The external_select button MUST be posted by the Claude bot (interactivity is per-app). Lead-only threads are skipped by `recordClientThreadExchange` (`conversations` has no `lead_id`) — the `client_threads` tag still indexes them. "Type a new topic" in the modal is a fast-follow (needs the catalog-pending flow); v1 modal lists existing `topic_templates` only.

_2026-06-21 (Phase 2.1) — modal now supports "Or type a new topic": optional free-text field; `ensureTopicSlugFromText` slugifies it and adds it to the topic_templates catalog (reusable next time). Script `post-client-conversation-button.mjs` hardened with an auth.test guard (refuses any non-Claude bot token)._
