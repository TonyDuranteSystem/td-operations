# Client Threads
_Last verified against code: 2026-06-22 — Antonio + Claude (Phase 2 + submit-timeout fix)_

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

**Key files:** `lib/ai-agent/slack-claude.ts` (`parseSlackInteractionFull`, `openSlackModal`, `buildClientConversationButtonBlocks`, `buildClientConversationModalView`, `searchClientsForSlackOptions`, `createClientConversationFromModal`, `lookupClientThreadContext`, `recordClientThreadExchange` + action_id/callback constants); `app/api/webhooks/slack-interactions/route.ts` (block_actions / block_suggestion / view_submission — Stop path unchanged; submit fires create in background via `fireClientThreadCreate`); `app/api/cron/client-thread-create/route.ts` (background create endpoint, CRON_SECRET bearer). Migration `20260621-1600-conversations-add-slack-channel.sql` (adds 'Slack' to `conversation_channel` enum). Tests: `tests/unit/client-conversation-form.test.ts`.

**Activation (one-time):** (1) prod enum: run `ALTER TYPE conversation_channel ADD VALUE IF NOT EXISTS 'Slack'`; (2) Slack app → Interactivity → **Options Load URL** = the `/api/webhooks/slack-interactions` route (Request URL already set); (3) post + pin the button in #td-support using `SLACK_BOT_TOKEN_CLAUDE` (must be the Claude app so clicks route to its interactivity endpoint — NOT the slack MCP app).

**Gotchas:** view_submission carries no channel → stashed in the modal's `private_metadata`. The external_select button MUST be posted by the Claude bot (interactivity is per-app). Lead-only threads are skipped by `recordClientThreadExchange` (`conversations` has no `lead_id`) — the `client_threads` tag still indexes them. "Type a new topic" in the modal is a fast-follow (needs the catalog-pending flow); v1 modal lists existing `topic_templates` only. **Slack gives view_submission only ~3s to respond** — the actual create (chat.postMessage + insert) runs on a cold start can exceed that and surface "We had some trouble connecting" even though the thread was created. The submit now responds instantly and fires the create to a background endpoint (`/api/cron/client-thread-create`, CRON_SECRET bearer) via `fireClientThreadCreate` — the same decoupling the @Claude events path uses (`fireWorkerTrigger`). The dedup "already open?" check stays synchronous (it must, to return the propose-continue `response_action:update` view).

_2026-06-21 (Phase 2.1) — modal now supports "Or type a new topic": optional free-text field; `ensureTopicSlugFromText` slugifies it and adds it to the topic_templates catalog (reusable next time). Script `post-client-conversation-button.mjs` hardened with an auth.test guard (refuses any non-Claude bot token)._

_2026-06-22 (submit-timeout fix) — modal submit was hitting Slack's 3s deadline on cold start (chat.postMessage + insert), showing "We had some trouble connecting" even though the thread was created (and a retry was safe — dedup catches the just-created open thread). Fixed by decoupling: `app/api/webhooks/slack-interactions/route.ts` now fires `fireClientThreadCreate` → new background route `app/api/cron/client-thread-create/route.ts` (calls `createClientConversationFromModal`), and responds `{}` immediately. Applies to both the first submit and the "Start new anyway" confirm step._

_2026-06-22 (one-click open + clearer wording) — to chat you must reply INSIDE the thread; typing in the main channel composer posts a loose message the worker ignores (correctly — it only listens inside open client_threads threads). Slack gives apps no way to auto-open a thread panel for a user, so `createClientConversationFromModal` now (a) posts an **ephemeral** "✅ Conversation started — 💬 Open conversation" message to the creator with a url button = `buildSlackThreadDeepLink(channel, threadTs)` (`.../p<ts_nodot>?thread_ts=<ts>&cid=<channel>` — the `thread_ts`+`cid` params are what open the thread view, not just scroll to it); and (b) reworded the root message to "Reply *inside this thread* to continue (… not the main channel box)". The url button's action_id `OPEN_CLIENT_THREAD_LINK_ACTION_ID` needs no handler — the interactions route's unknown-action fall-through ACKs it._

_2026-06-22 (link "no access" fix) — the propose-continue modal's "Open the existing conversation" link (and the new ephemeral button) used a bare `https://slack.com/archives/CH/pTS` link, which gave "You don't have access to this message" on thread parents. Replaced with `getSlackPermalink()` (Slack's `chat.getPermalink` — the canonical "Copy link" URL: team subdomain + thread_ts + cid, always opens) with `buildSlackThreadDeepLink()` as fallback. Applied in both `findOpenConversationForEntityTopic` (propose-continue link) and `createClientConversationFromModal` (ephemeral button)._

_2026-06-22 (Follow → personal DM list — Step 1 of the "follow until closed" combo) — Slack gives apps no API to follow a thread or save to "Later" for a user (verified in Slack docs), so follow is tracked in our DB. The 🗂️ folder message now carries a **"👀 Follow" button** (`FOLLOW_CLIENT_THREAD_ACTION_ID`, `buildClientThreadRootBlocks`). Clicking it: the interactions route ACKs instantly and fires `/api/cron/client-thread-follow` → `handleFollowToggle` (`lib/ai-agent/client-thread-follows.ts`) resolves the thread by `source_ref` (channel:message_ts), toggles a `client_thread_follows` row for that user, posts an ephemeral confirmation, and rebuilds that user's **"📌 Following" DM** (one message kept updated via `chat.update`, tracked in `slack_follow_digests`; rows are followed + `status='open'` threads, each a `getSlackPermalink` link). A conversation **drops off automatically when closed** — `closeClientThread`/`reopenClientThread` call `refreshFollowersDigests`. DM uses `chat:write` (no new scope). Tables: migration `20260622-1300-client-thread-follows.sql`. Pure renderer `renderFollowDigestText` unit-tested. **Step 2 (shared #td-support Canvas of all open conversations) is the next slice — needs the `canvases:write` scope (added) + reinstall.**_

_2026-06-22 (multi-channel + 🗑️ remove — Luca's blockers) — (1) **Topic channels:** conversations can now live outside #td-support. The modal has a **channel picker** (`conversations_select`, `CHANNEL_SELECT_BLOCK_ID`/`CHANNEL_SELECT_ACTION_ID`, defaults to the invoking channel) so the ⚡ shortcut/button can target e.g. #td-taxreturn; the submit posts to the picked channel (`targetChannel`) and falls back to a graceful ephemeral ("invite me with /invite @Claude") in the invoking channel if the bot isn't a member. The worker already engages in any channel (`isOpenClientConversationThread` is channel-agnostic); auto-tag stays #td-support-only. **Requires the Claude bot to be invited to each topic channel.** (2) **🗑️ Remove:** react 🗑️ (wastebasket) on a 🗂️ root message → `removeClientThreadCard` deletes the Slack message (`chat.delete`) AND the `client_threads` row (CASCADE drops follows) + refreshes ex-followers' DM lists. Fixes "I can't delete the cards." Background-create now also carries `notifyChannel` for the not-in-channel error. **Known related side effect:** background-create made the client+topic dedup slightly racy (two fast submits can both miss it)._

_2026-06-22 (Step 2 — shared Canvas) — a channel Canvas in #td-support ("🗂️ Open client conversations") now lists ALL open Slack client_threads (across channels), each a markdown link that opens its thread; auto-rebuilt on create/close/reopen/remove. `refreshOpenConversationsCanvas()` (`client-thread-follows.ts`) queries open threads → names → `getSlackPermalink` (cap 50) → `renderCanvasMarkdown` (pure, unit-tested) → `ensureChannelCanvasId` (conversations.info → `channel.properties.canvas.file_id`, else `conversations.canvases.create`) → `canvases.edit` `{operation:'replace'}` full overwrite. Hooked into the create endpoint + close/reopen + `removeClientThreadCard`; all best-effort. **Requires the `canvases:write` (+`canvases:read`) scope AND an app REINSTALL** — until reinstalled, canvas calls fail with missing_scope (caught, no crash; the rest of the feature works). Rebuild-from-DB each time = idempotent; the close path runs it inline so a Slack retry just re-renders the same content._

_2026-06-23 (read-method GET fix + canvas error surfacing + ghost cleanup) — (1) `chat.getPermalink` and `conversations.info` are GET endpoints; calling them as POST+JSON via `slackApiCall` returned ok:false → null permalinks → DM-list/Open-conversation/propose-continue links fell back to the broken generic-domain link ("can't open the conversation"). New `slackApiGet(method, params)` (GET + query) is now used by `getSlackPermalink` and `ensureChannelCanvasId`'s conversations.info. (2) `refreshOpenConversationsCanvas` now returns `{ok,error}` and the create endpoint posts the EXACT Slack error to the creator as an ephemeral when the Canvas fails (e.g. missing_scope if canvases:write isn't really on the BOT token after reinstall) — no more silent canvas failures. (3) **Ghost rows:** deleting a card MANUALLY in Slack (not via 🗑️) leaves the client_threads row open, pointing at a deleted message → dedup proposes a dead link. Cleaned the Alessandro Federici ghost by hand; **systemic auto-heal (message_deleted event → close the row) is still TODO.**_

_2026-06-21 (Phase 2.2) — added a GLOBAL SHORTCUT entry point ("new_client_conversation") so the form opens from the ⚡ shortcuts menu (always available, never scrolls away) instead of relying on an in-channel button. Global shortcut has no channel → defaults the new thread to SLACK_SUPPORT_CHANNEL_ID. Route handles type="shortcut"; openConversationModal shared by button + shortcut._

_2026-06-21 (Phase 1b) — per-entity COLLAPSIBLE Conversations panel on contact/account/lead pages (no rollup: a thread shows only under the entity it was tagged to). Reads client_threads for that entity; each row = topic · date · Slack link; expand pulls the thread messages LIVE from Slack (fetchSlackThreadMessages → conversations.replies). New: /api/client-threads (list) + /api/client-threads/[id]/messages (expand), components/conversations/client-conversations-panel.tsx._

_2026-06-21 (Phase 1b polish) — cleanSlackText() renders thread messages readable in the CRM panel (resolves <@user> mentions to names, strips :emoji: shortcodes + *bold*/_italic_/`code`, unwraps <url|label>). Backfilled crm_log rows now expand to their stored conversations content (client_message/response_sent) instead of "no thread"._

_2026-06-22 (Phase 2.3) — CLOSE a conversation (frozen transcript). New client_threads cols transcript/closed_at/closed_by (migration 20260622-0900). closeClientThread snapshots the full thread into transcript + status=closed; reopenClientThread reverts to live. Close from CRM (Close/Reopen button in the panel → /api/client-threads/[id]/close) OR from Slack (✅ reaction on the conversation's starting message). Closed → messages endpoint serves the frozen snapshot (permanent, survives Slack deletion)._

_2026-06-22 (Phase 1b polish) — Conversations panel now shows timestamps: each message renders its date+time (fmtSlackTs), and the row header shows "Opened <date time>" (fmtDateTime)._

_2026-06-22 (Phase 2.4) — propose-continue dedup: the form, on submit, checks for an existing OPEN conversation for the same client+topic (findOpenConversationForEntityTopic). If found, it updates the modal (buildDuplicateConfirmView) showing "already open, opened <date>" + a link to continue there, or "Start new anyway" (carries the selection in private_metadata confirm:true → second submit skips the check and creates). Prevents form+@Claude duplicates; one open conversation per client+topic._

_2026-06-22 (Phase 2.5) — /client SLASH COMMAND: new app/api/webhooks/slack-commands route opens the same client-conversation modal by typing /client (reliable entry point since the global shortcut is hard to find). Shared openClientConversationModal helper now used by all three entry points (button, shortcut, slash command); interactions route refactored to it._

_2026-06-22 (Phase 3 Part 1+3) — per-client brain. decision_memory gets a client_key + a sibling recall fn match_decision_memory_client (original untouched). saveDecisionMemory accepts clientKey; recallClientDecisionMemory + buildClientRecallSuffix inject "WHAT WE KNOW ABOUT <client>" before the worker answers in a tagged client thread (callWorker opts.clientKey/clientName, set by processSlackEvent). FEED (human-confirmed only, no poisoning): closing a conversation saves its transcript as a client-scoped memory (closeClientThread). Migration 20260622-1100._

_2026-06-22 (Phase 2.6) — /client conversation threads are now dedicated worker threads: a plain reply (no @Claude) in an OPEN client_threads thread is processed by the worker (route.ts isOpenClientConversationThread relaxes Case 3 of the invitation gate; Case 2 explicit @other still skips; closed threads not auto-answered). Labeled message updated to "Just reply here — I am listening". Fixes having to @Claude every message + drifting to separate untagged threads._
