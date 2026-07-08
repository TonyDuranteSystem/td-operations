# Team Workspace (internal Slack-replacement chat)
_Last verified against code: 2026-07-07 — Claude (Phase 1 built in SANDBOX on branch `claude/ecstatic-pasteur-10660b`, NOT yet on production. Goal per Antonio: replace Slack entirely so the team has ONE place to work — no extra app/fee. This is the staff-only internal chat, distinct from the client portal chat in `portal.md`.)_

## What it is
The internal team chat, rebuilt from a single "Team General" room into a full workspace: **named channels**, **direct messages**, **client discussions**, and a **general** room — all staff-only, never client-visible. Reactions, edit-with-history, pins, message search, @mentions with targeted push, colored rich cards, and an **@claude** AI-worker trigger. Backed by the same `internal_threads` / `internal_messages` tables that already powered the old team chat + `portal_team_send` (so nothing pre-existing broke — the change is additive).

Two UI surfaces read these tables and both keep working:
- `/team-chat` — the new **Team Workspace** page (this subsystem).
- CRM **Portal Chats → Team tab** (`app/(dashboard)/portal-chats/page.tsx`, `view=internal`) — the legacy per-client internal-thread view, untouched. `portal_team_send` still writes here.

## Data model
`internal_threads` — one row per channel / DM / discussion / general room. `thread_type` ∈ `general | channel | discussion | dm` (CHECK). Channel cols: `channel_name`, `channel_slug` (partial-unique), `description`, `color`. DM col: `dm_key` = sorted `"idA:idB"` (partial-unique → one thread per pair). `resolved_at` (discussions), `archived_at`, `last_activity_at` (sidebar sort). Legacy cols retained: `account_id`, `contact_id`, `source_message_id`, `title`, `created_by`.

`internal_messages` — `reactions` jsonb `[]`, `edited_at` + `original_message` (edit history), `pinned_at`/`pinned_by`, `mentions` jsonb (matched handles), `card` jsonb (rich card). Legacy retained: `attachments`, `reply_to_id`, `deleted_at`/`deleted_by` (R100 soft-delete), `read_at`/`seen_at` (legacy — superseded for unread by the reads table).

`internal_thread_reads` — **per-user read pointer** (`thread_id`, `user_id`, `last_read_at`, PK both). This is the unread model. Staff-only RLS matching the sibling tables (prod has RLS on; sandbox off — a green sandbox test does NOT prove RLS).

Realtime publication members: `internal_messages` (pre-existing) + `internal_threads` + `internal_thread_reads` (added Phase 1).

## Read-side RPCs (avoid N+1)
- `get_team_threads(p_user_id)` → every visible thread + **per-user `unread_count`** (`msgs where created_at > COALESCE(last_read_at,'-infinity') and sender_id<>user and deleted_at is null`) + last-message preview. DMs filtered to those whose `dm_key` contains the user id; channels/general/discussions visible to all staff. Excludes `archived_at`.
- `search_team_messages(p_user_id, p_query)` → ILIKE search across visible messages (same DM rule), cap 50.
- `toggle_internal_message_reaction(msg, emoji, reactor_id, reactor_name)` → atomic add/remove keyed on (emoji, reactor). Mirror of `toggle_message_reaction` (that one is bound to `portal_messages` — do NOT reuse it here).

## New conversation (native, Slack-independent — the Client-Threads modal, reimagined)
The "New conversation" entry on the **Client Discussions** sidebar header opens a modal (mirrors the Slack Client-Threads modal) — pick a **client** (account/contact/lead search), an optional **topic** (from the `topic_templates` catalog or free-typed), and optionally a **channel** to also drop a card into. It creates (or reuses) a `thread_type='discussion'` thread anchored to that client + topic. Purely native — no Slack.
- `GET /api/team/client-search?q=` — accounts (`company_name`) + contacts (`full_name`) + leads (`full_name`), staff-only, returns `{value:"<kind>:<uuid>", label, sublabel, kind}` (mirrors the Slack modal's 3-table search). Topics come from the existing `GET /api/portal/chat/topic-templates`.
- `POST /api/team/conversations` — body `{ client:"account|contact|lead:<uuid>", topic?, channel_id? }`. Parses the client ref (`lib/team/conversations.ts::parseClientRef`), resolves the display name, **finds-or-reuses** an OPEN discussion for the same client+topic (dedup on `(clientCol, topic_slug)`), else creates one titled `"<client> · <topic>"` + seeds a "🗂️ Conversation started" message. Optional `channel_id` drops a rich card (`kind:client_message`, link `/team-chat?thread=<id>`) into that channel.
- Schema: `internal_threads` gained `topic`, `topic_slug`, `lead_id` (migration `20260708-0100`). The page honors `?thread=<id>` to deep-select (used by the channel card + push links).

## API routes (`app/api/team/*`, all staff-only via `isDashboardUser`)
- `GET /threads` — sidebar payload: `get_team_threads` + staff directory (`listTeamMembers`) + current user.
- `POST /channels` — create channel (slug from name, unique). `POST /dms` — find-or-create DM by `dm_key`.
- `GET /threads/[id]` — messages (+ reply previews) and **advances the caller's read pointer**. `PATCH /threads/[id]` — rename/recolor/resolve/archive. `POST /threads/[id]/read` — advance read pointer only (badge clear).
- `POST /threads/[id]/messages` — send. Resolves @mentions → targeted push (`sendPushToAdminUsers`) for mentioned staff, else broadcast-excluding-sender; validates card + attachment host; fires the **@claude** trigger when `@claude`/`@ai` is present.
- `PATCH /messages/[id]` (edit, author-only, preserves `original_message`) / `DELETE` (soft-delete, author or admin). `POST /messages/[id]/react` / `/pin`.
- `GET /search?q=` — `search_team_messages`.
- `POST /upload-url` — signed direct-to-Storage URL (100MB) → `assets` bucket `team-chat/<threadId>/`, bypassing the serverless body limit (the flaw the old `/api/internal/threads/[id]/upload` had at 10MB).
- `POST /claude/process` — internal, CRON_SECRET-authed, `maxDuration=300`. Runs the shared worker and rewrites the placeholder.

## @claude adapter (`lib/team/claude-trigger.ts`)
A human `@claude` mention → `triggerClaudeReply` inserts a placeholder message (sender = `CLAUDE_SENDER_UUID` sentinel, body `…`) and fires `/api/team/claude/process` (bounded direct-trigger, like the Slack worker). `processClaudeReply` reuses `callWorker` from `lib/ai-agent/worker-tools.ts` (same brain as Slack/Hermes), builds context from recent thread messages + client linkage (`clientKey`/`clientName` when the thread has an account/contact — the per-client brain), then rewrites the placeholder with the answer (TOCTOU-guarded on the placeholder body).
- **Rails:** research/read on for everyone (`enableDbRead/DocReads/CallReads/Calendly/ClientThreadRead/WebSearch`). **Code-task rail Antonio-only** (`enableCodeTasks = isAdmin`, R111). **Send rails OFF** in team chat for now (research-first, mirrors Hermes Phase 1).
- **Loop-safety:** only human sends reach the send route; `processClaudeReply` refuses a prompt authored by the Claude sentinel. Claude's own posts never re-trigger.

## Pure helpers (`lib/team/workspace.ts`, unit-tested)
`parseMentionHandles` (ignores emails), `mentionsClaude`, `dmKey`, `channelSlug`, `validateHexColor`, `validateTeamCard`, `TEAM_COLORS`, `CLAUDE_SENDER_UUID`/`CLAUDE_SENDER_NAME`/`CLAUDE_MENTION_ID`. `lib/team/directory.ts` = staff directory + `resolveMentions` (handle→user id). `lib/team/attachment.ts` = client-side signed-URL upload (reuses `validateChatAttachment` so team + client chat share size/type policy).

## Slack channel mirror (read-only feed — ships DORMANT)
A read-only view of the Slack channels the bot is in, inside the workspace, so the team can watch Slack from the CRM during the parallel-run before Slack is decommissioned. Gated on the `slack_mirror_enabled` app_setting (default **false** — dormant; prod has no row → off).
- **Tables:** `slack_channels` (id/name/is_member/last_message_at…) + `slack_messages` (`(channel_id, ts)` PK, thread_ts, author, text, subtype, deleted, posted_at, raw). Staff-only RLS. Migration `20260708-0300`.
- **Two feeds into the mirror:** (1) LIVE — the production Slack webhook (`app/api/webhooks/slack-claude/route.ts`) calls `ingestSlackMessageEvent(event)` for every channel `message` event, ADDITIVELY before the worker routing (worker behaviour unchanged; best-effort; no-op when the flag is off). (2) BACKFILL — `POST /api/team/slack/sync` runs `syncSlackChannels()` (conversations.list) + `backfillChannelHistory()` (conversations.history) — internal app is exempt from the 2025 Slack rate limits.
- **Module:** `lib/team/slack-mirror.ts` (server) + pure `lib/team/slack-mirror-classify.ts` (`classifySlackEvent` handles new/edit(message_changed)/delete(message_deleted); `resolveSlackMentions`; `KNOWN_SLACK_USERS`). Idempotent upsert on `(channel_id, ts)` for Slack retries.
- **Read APIs:** `GET /api/team/slack/channels`, `GET /api/team/slack/channels/[id]/messages` (Open-in-Slack via `buildSlackThreadDeepLink`), `POST /api/team/slack/sync`. All staff-only + kill-switch-gated.
- **UI:** a "Slack" sidebar section (only when enabled) → click a channel → read-only feed with per-message + channel "Open in Slack"; footer "reply in Slack" (no CRM→Slack posting in this slice).
- **Scope note:** the app has `channels:read` + `channels:history`. Human display names use a 3-person `KNOWN_SLACK_USERS` stopgap; full name resolution for everyone needs the `users:read` scope + a users.info cache in the sync. Private channels need `groups:read`/`groups:history` + `message.groups`. CRM→Slack posting needs `chat:write.customize`.
- **Verified in sandbox** (2026-07-08): synced 11 real channels + 183 messages via local bot token; feed renders real #td-dev history with names + mentions resolved + working deep links. Live event flow is **prod-only** (webhook is the prod URL) — verify after switch-on there.

## Organizer layer — channel-folders, kanban board, mark-unread + Later (2026-07-08)
Turns the workspace into a lightweight work tracker (Antonio's request).
- **Channels are FOLDERS that hold threads.** `internal_threads.parent_channel_id` points at the channel a discussion/topic is filed under (null = unfiled). The sidebar renders each channel as an expandable folder containing its filed threads; the ⋯ menu on a thread has "Move to channel" (any channel or "No channel"). Move = PATCH `/api/team/threads/[id]` `{ channel_id }`.
- **One kanban board of all work threads.** `internal_threads.work_status` ∈ `todo|in_progress|waiting|handled` (CHECK; default `todo`; backfill: resolved→handled). The **List | Board** toggle (`ViewToggle`) in the header switches the whole pane to `app/(dashboard)/team-chat/board.tsx` — 4 columns, each thread a draggable card (reuses `@hello-pangea/dnd`, same as the tasks kanban), filterable by channel, DMs excluded. Drag → PATCH `{ work_status }`. **`handled` IS the done state**: setting it stamps `resolved_at`, moving off it clears `resolved_at` (kept in sync so the resolve toggle + anything reading `resolved_at` stays consistent).
- **Mark-unread + Later are PER-USER** (`internal_thread_reads.manual_unread`, `.later`). `POST /api/team/threads/[id]/mark-unread` forces the badge on until the thread is next opened (GET/`/read` clear `manual_unread`). `POST /api/team/threads/[id]/later` `{ later }` pins the thread to a "LATER" sidebar section (amber clock indicator). `get_team_threads` returns `work_status`, `parent_channel_id`, `later`, and `unread_count = GREATEST(computed, manual_unread?1:0)`.
- Pure helpers `TEAM_WORK_STATUSES`/`TEAM_WORK_STATUS_LABELS`/`isValidWorkStatus` in `lib/team/workspace.ts` (unit-tested). Migrations `20260708-1400` (schema) + `20260708-1500` (RPC — DROP+CREATE, signature changed).
- Verified in sandbox browser: move a discussion into a channel (nests under the folder), mark-unread (badge returns), Later (LATER section), board renders + status change re-groups the card. Physical drag can't be automated (library limitation) but the operation it triggers is verified.

## Business rules / invariants
- **Staff-only, never client-visible.** All routes gate on `isDashboardUser`; RLS is staff-only.
- **Unread is per-user** via `internal_thread_reads`. Do NOT reintroduce logic based on the single `read_at` column for unread (it made counts always 0 — the pre-Phase-1 bug, because sends stamped `read_at=now()`).
- **@claude requires an explicit mention**; the worker never listens ambiently. Code tasks Antonio-only; send tools are not wired into team chat.
- **Attachments** must live on our Storage host (send route rejects off-host URLs); 100MB via signed URL, active-content block-list (shared with portal chat).

## How to verify current state
- `get_team_threads(<a staff user id>)` returns rows with correct `unread_count` (own messages don't count; another user's messages do until they GET the thread or POST /read).
- Confirm columns: `SELECT column_name FROM information_schema.columns WHERE table_name IN ('internal_threads','internal_messages','internal_thread_reads')`.
- Confirm realtime: `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename LIKE 'internal_%'` → all three.
- @claude needs `ANTHROPIC_API_KEY` + `CRON_SECRET` on the environment; push needs VAPID keys. Sandbox blocks outbound email but push/worker work.
- Migrations: `scripts/migrations/20260707-1900-team-workspace-phase1.sql` (schema) + `20260707-2000-team-workspace-read-rpcs.sql` (RPCs). Applied to sandbox; NOT promoted to prod.

## Not yet built (later phases)
Slack ingestion/mirror + post-from-CRM (behind kill-switch), colored Send-to-Team cards from account/invoice/doc/task pages, client-message → discuss/task/Slack bridges, PWA mobile hardening, Slack history import + decommission. See dev_task "Team Workspace — replace Slack".
