# Slack Claude Worker

**Subsystem:** `slack-claude-worker`
**Last verified against code:** 2026-06-23 (FOLLOW-ANY-THREAD via 👀 + per-channel Canvas: new lib/ai-agent/slack-thread-follows.ts; 👀 react on any thread follows it, each channel gets its own Followed-conversations canvas. Needs reaction_removed subscription. See client-threads.md. Prior: CLOSE-BUTTON FIX: the ✅ Close button never persisted — handleCardAction passed the Slack user id into the closed_by uuid column → UPDATE failed; now passes null + checks the result. See client-threads.md. Prior: CANVAS FIXED + FOLLOWED-FILTER: one fixed canvas id, lists only team-followed conversations, thread_ts deep links; dup-create logic removed. See client-threads.md. Prior: FULL CARD CONTROL PANEL: 🗂️ card now has 💬 Open · 👀 Follow · ✅ Close · 🗑️ Remove buttons (closed→Reopen) via /api/cron/client-thread-action + handleCardAction; shared Canvas dropped. See client-threads.md. Prior: ONE CARD, WORKING LINKS: buildSlackThreadDeepLink now uses the workspace subdomain (tdoperationsworkspace.slack.com) so links actually open; 💬 Open + 👀 Follow now both live on the 🗂️ card (one message), separate ephemeral removed. See client-threads.md. Prior: Slack read-method GET fix: getPermalink/conversations.info now use slackApiGet (GET) so permalinks resolve + canvas errors surface to the creator; see client-threads.md. Prior: 2026-06-22 (SHARED CANVAS — a #td-support channel Canvas ("🗂️ Open client conversations") auto-lists all open client_threads with clickable links via `refreshOpenConversationsCanvas` (conversations.canvases.create / canvases.edit replace); needs canvases:write + REINSTALL. Detail in `client-threads.md`. Also: MULTI-CHANNEL + 🗑️ REMOVE — client conversations can now be created in topic channels (modal channel picker `conversations_select`; needs the bot invited to that channel) and removed by reacting 🗑️ on the 🗂️ root (`removeClientThreadCard` → `chat.delete` + row delete). Detail in `client-threads.md`. Also: FOLLOW → PERSONAL DM LIST — the 🗂️ folder message now has a "👀 Follow" button; clicking toggles a per-user follow (`client_thread_follows`) and the bot keeps a "📌 Following" DM list (`slack_follow_digests`, `chat.update`) of that user's followed + open conversations, each a clickable permalink, auto-dropping on close. New `lib/ai-agent/client-thread-follows.ts` + `/api/cron/client-thread-follow`; migration `20260622-1300-client-thread-follows.sql`. DM uses chat:write (no new scope). Full detail in `client-threads.md`. Prior: 2026-06-22 (CLIENT-CONVERSATION FORM UX — the Slack `/client` form (`slack-claude.ts`): (1) modal submit now creates the thread in the BACKGROUND (`fireClientThreadCreate` → `/api/cron/client-thread-create`) and responds instantly, to beat Slack's ~3s view_submission deadline (cold-start was surfacing "We had some trouble connecting" though the thread WAS created); (2) one-click "Open conversation" ephemeral button posted to the creator + clearer "reply inside this thread, not the main channel box" root wording; (3) `getSlackPermalink` (`chat.getPermalink`) replaces bare `/archives/CH/pTS` links that gave "You don't have access to this message" on thread parents, with `buildSlackThreadDeepLink` fallback. FULL DETAIL in `client-threads.md`. Prior: 2026-06-21 (SELF-SERVE BEFORE ASKING — worker discipline: added a generic principle to `SLACK_WORKER_SYSTEM_PROMPT` (ENGINEERING DISCIPLINE block) — never ask Antonio for a fact the system can give (a client's language, email, invoice-paid status, which service, any status); look it up first via the client's CRM record / `run_sql_query` / CRM searches / `portal_chat_read` / KB/SOPs/sysdocs; only ask for a genuine judgment call (price/strategy/exception). NOT a hardcoded business rule — a flexible "consult the truth first" habit that makes the worker use the knowledge system. Added after it asked Antonio "which language?" when the contact's CRM `language` was Italian (Gritti/Evolue). Behavior item 5 amended to "look it up first". Prompt-bloat ceiling 9600→10200; prompt-shape test asserts SELF-SERVE + the which-language case. Prior: 2026-06-20 (HEADLESS PERMISSION FIX: the runner's `claude --print` session runs in a THROWAWAY worktree that lacks `.claude/settings.local.json` (gitignored — where the `Bash(git/npm/gh:*)` grants live), and `--permission-mode acceptEdits` only auto-approves EDITS, not Bash — so git/npm commands hung on a permission prompt no human can answer in headless mode → the session made the edits but could NOT commit/push (Fax History retry, 2026-06-20). The OLD runner only worked because it ran inside the MAIN checkout, which HAS settings.local.json. FIX (`scripts/mac-mini/code-task-runner.mjs::runInteractiveClaude`): always pass `--dangerously-skip-permissions` (standard headless-autonomy flag) + strip any `--permission-mode` pair from `CLAUDE_EXTRA_ARGS` to avoid a conflicting flag. Safety is the isolated worktree + pre-push build/test gate + review-branch + human "ship it", not a per-command prompt. SANDBOX E2E PROVEN: a commit-including task now pushes a review branch through the gate (first fully-successful end-to-end run; resolves the earlier 'completed with no branch' mystery — same root cause). Optional future: a per-command/risk-tiered Allow rail surfaced to CRM/Slack (Claude Code `--permission-prompt-tool`) — discussed, not built. Prior: 2026-06-20 (CRM CODE-TASKS Phase 2+3: (2) RUNNER HEALTH + STUCK ALERT — the Mac Mini runner now upserts a liveness heartbeat into `hermes_instances` (reused generic table; `instance_id='code-runner-mac-mini'`, `last_heartbeat`, `status='online'`) every tick (~15s), best-effort. `GET /api/code-tasks` returns `runner` (online if heartbeat ≤60s) + per-task `stuck` (pending >3min or processing >35min), computed by pure `lib/code-tasks/health.ts` (`runnerHealth`/`isTaskStuck`, tests `tests/unit/code-task-health.test.ts`). The list page shows a "Mac Mini online/offline · Ns ago" badge, an offline banner, and a per-row "⚠ stuck" chip. (3) START-FROM-CRM — `POST /api/code-tasks` {title?, instructions} inserts a pending `code_runner` row (source='crm', no Slack context → reports only in the CRM viewer); the list page has a "+ New task" form. Tests now 3498 green, build green. Prior: 2026-06-20 (CRM CODE-TASKS CONTROLS — Phase 1: the dashboard Code Tasks pages (`app/(dashboard)/code-tasks/`, admin-only, already had a live transcript viewer via `code_task_events` + an interactive steer/input box via `code_task_inputs`) gained ACTION controls on the detail page: **Ship it** (approve→promote), **Retry**, **Cancel**, **Dismiss**. New `POST /api/code-tasks/[id]/action` maps each to an agent_messages mutation via the pure, unit-tested `decideCodeTaskAction()` (`lib/code-tasks/actions.ts`): promote = insert a NEW `recipient='code_runner'` row with `context_json.promote_branch` (identical to the Slack "ship it" path → runner's `promoteBranchToMain`); retry = flip the SAME row `→pending`; cancel = flip a not-yet-claimed `pending` row `→cancelled` (TOCTOU-guarded; a live `processing` session is stopped via the viewer's End Session, not a hard kill); dismiss = cosmetic `context_json.dismissed=true` (list API filters it out). Tests: `tests/unit/code-task-actions.test.ts` (13). Phase 2 (heartbeat 'Mac Mini online' badge + stuck-job alert) and Phase 3 (start-a-task-from-CRM) pending. Prior: 2026-06-20 (CODE-TASK PUSH TIMEOUT FIX: the Mac Mini runner's two build-gated `git push` calls (`scripts/mac-mini/code-task-runner.mjs`) used `execSync` `timeout: 120000` (2 min), but the `.husky/pre-push` gate runs `next build` + full tests which exceeds 2 min → the push died mid-build with `spawnSync /bin/sh ETIMEDOUT`, falsely marking the task `failed` even though edits committed fine. Diagnosed from the Fax History task (2026-06-20): worker discussed→approved→queued correctly, runner applied all 5 edits, only the push timed out. FIX: new `GATED_PUSH_TIMEOUT_MS = 10*60*1000` constant used by BOTH the branch push and the `ship it` promote push; 10 min sits inside the 30-min task SIGKILL. NOTE: runs on the Mac Mini — takes effect only after the Mac Mini pulls main + the launchd daemon restarts. No new test (it's an execSync option). See "Code-task rail". Prior: 2026-06-19 (HUMAN-TONE CLIENT DRAFTS — NO ASTERISKS: Antonio asked the worker's client-facing drafts to drop markdown asterisks and read like a human, not an AI. TWO layers, scoped to CLIENT DRAFTS only (the worker's own Slack chat keeps `*bold*`): (1) PROMPT — a new DRAFTS block in `SLACK_WORKER_SYSTEM_PROMPT` (`slack-claude.ts`) tells the worker that email bodies + portal messages must be plain human prose, NO asterisks/markdown/headers/bullet-dumps, explicitly noting Slack replies to the team may still use `*bold*`. (2) HARD SANITIZER — new pure `stripDraftMarkdown()` (`worker-tools.ts`, exported, unit-tested) unwraps bold/italic asterisk pairs, turns line-start `* ` bullets into `- `, and removes any stray `*`; applied in `executeWorkerTool` ONLY on the worker's two client-send paths — `send_email` (body + subject, before delegating to the shared `send_email` AGENT tool) and `sendPortalMessageFromWorker` (message, before dedup/insert/notify). The shared `send_email` AGENT tool + the in-dashboard agent are NOT sanitized (the sanitizer lives in the worker dispatch). Prompt length 8596→9102 (ceiling 9600, unchanged). Tests: `tests/unit/worker-draft-sanitizer.test.ts` (zero-asterisk guarantee, bullets→dashes, plain text unchanged, empty-safe) + a prompt-shape assertion in `tests/unit/slack-claude-worker.test.ts`. See "Human-tone client drafts" below. Prior: 2026-06-19 (REFERENCED-THREAD REACH + STEP-LIMIT CONVERGENCE: two fixes after the #td-implemenation-request incident where Antonio shared Luca's P&L request onto a `@Claude` post and Claude replied "I don't see Luca's request in this thread" then bailed with "I reached my working limit (up to 20 steps)". (1) REFERENCED-THREAD REACH: the worker can now read a SHARED message (Slack "Share message" → an attachment carrying the source `channel_id`+`ts`) or a PASTED archive link (`…/archives/C…/p…?thread_ts=…`). New pure parsers in `slack-claude.ts` — `pTimestampToTs`, `parseSlackArchiveLinks`, `parseSlackShareAttachments`, `collectSlackReferences` (dedup by channel:thread_ts, cap `MAX_SLACK_REFERENCES=3`). The webhook (`route.ts`) calls `collectSlackReferences({text, attachments})` and stores `context_json.slack_referenced` (pure, no Slack API call → safe inside the 3 s ACK window). `processSlackEvent` merges stored refs + a re-parse of `row.body` (link safety-net), then `fetchReferencedThreads` resolves each via `conversations.replies` (reusing `fetchThreadHistory`, now with an optional `charCap`; caps `REFERENCED_THREAD_MSG_LIMIT=30` / `REFERENCED_THREAD_CHAR_CAP=8000`), skipping any ref equal to the current thread, and injects a `[REFERENCED SLACK THREAD(S)…]` block ahead of the current message. Best-effort throughout (bot not in channel / deleted → skip). (2) STEP-LIMIT CONVERGENCE: `runWorkerLoop` (now exported) no longer returns the generic "working limit" message the instant the loop exhausts — it first makes ONE final NO-TOOLS call forcing the model to synthesize what it found into a real answer (guarded on remaining wall-clock budget; falls back to the generic message only on failure/empty). Tests: `tests/unit/slack-claude-worker.test.ts` (parser + `fetchReferencedThreads` + ref-injection in processSlackEvent), `tests/unit/worker-loop-convergence.test.ts` (forced synthesis, fallback, normal end_turn). See "Referenced-thread reach" + "Step-limit convergence" below. Prior: 2026-06-18 (HERMES-MISATTRIBUTION FIX + LUCA IDENTITY: the Slack worker wrongly told Luca it "saw the test invoice Hermes created" and that "Hermes will create the real invoices" — Hermes is dismissed. Root cause (verified in `slack-claude.ts`): `fetchThreadHistory` only labeled three Slack ids (Claude/Antonio/Hermes), so Luca (`U0B9ZUE2Q75`) fell back to "Someone"; combined with `SLACK_WORKER_SYSTEM_PROMPT` still framing Hermes as an active teammate ("CONTEXT … sometimes Hermes" + a whole "SHARED THREADS" block), the worker filled the unnamed "Someone" with Hermes. FIX: (1) added `SLACK_USER_LUCA = "U0B9ZUE2Q75"` → label "Luca" + `<@U0B9ZUE2Q75>`→`@Luca` mention rewrite; (2) removed the Hermes sender-label branch + `<@…D3MAD9B>`→`@Hermes` rewrite + the `SLACK_USER_HERMES` constant (Hermes dismissed — unknown ids stay "Someone"); (3) rewrote the prompt CONTEXT to "Antonio + the team (e.g. Luca)" and replaced the Hermes "SHARED THREADS" block with an ATTRIBUTION rule: attribute only to the labeled sender, treat "Someone" as unknown, never invent a participant. The hermes-bridge code itself is untouched (Antonio: leave the bridge alone). Tests updated in `tests/unit/slack-claude-worker.test.ts` (Antonio/Luca labeling, `@Luca` rewrite, dismissed-Hermes-id→"Someone" regression, prompt no longer matches /Hermes/ + has ATTRIBUTION+Luca). Prior: 🧠 BRAIN-REACTION THREAD-REPLY FIX (Decision Memory Phase 7): the `reaction_added`→save handler (`app/api/webhooks/slack-claude/route.ts`) fetched the reacted message via `conversations.history`, which only returns TOP-LEVEL channel messages — so reacting 🧠 to a thread reply (Claude's answers are almost always threaded) saved the PARENT message instead. Found on the FIRST live 🧠 test: reacting to Claude's lesson reply saved Antonio's parent question. FIX — new `fetchSlackMessageText(channel, ts)` + pure exported `pickMessageTextByTs(messages, ts)` in `slack-claude.ts`: accept the `conversations.history` result ONLY when its ts matches exactly, otherwise fall back to `conversations.replies` (which includes thread replies) and pick the exact ts. Same `channels:history` scope, no new permission. Tests: `tests/unit/slack-reaction-fetch.test.ts` (matching ts not first = the bug, no-match→null, empty→null). Prior: CALENDLY READ RAIL (Slack-only, R108): the Slack worker can now read Antonio's Calendly via three READ-ONLY tools — `cal_list_bookings` / `cal_get_event_details` / `cal_get_availability` (upcoming/past bookings, who-booked + form answers, and the active booking pages/links). Gated by new `CallWorkerOptions.enableCalendly` (set in `processSlackEvent`; kept OUT of `WORKER_TOOLS` so the Hermes/Telegram research worker never gets them) + an executor `availableNames` gate (defense-in-depth). The three reads reuse SHARED functions extracted from `lib/mcp/tools/calendly.ts` (`listCalendlyBookings` / `getCalendlyEvent` / `getCalendlyAvailability`) — the MCP `cal_*` tools call the same functions, single source of truth. Read-only: NO create/cancel. Token `CALENDLY_PAT`. Tests: `tests/unit/worker-calendly-reads.test.ts` (not-in-WORKER_TOOLS, executor gating, network-free no-token error path). See "Calendly read rail". Prior: 2026-06-18 (IN-CHANNEL APPROVAL COMPLETION (loop fix): the Slack worker only PROPOSES writes (`propose_action` mints a pending `approval_queue` row with a fresh 6-digit `confirmation_code`); it had no approve tool and nothing consumed a typed code, so typing the code back re-invoked the LLM → re-propose → loop (precedent: 3 stuck `lead_create` proposals for "Tobias Toft", earlier `send_email` proposals expired unactioned). FIX — Part A: `proposeAction` now stores `source_message_id` (FK→`agent_messages.id`), threaded server-side via `callWorker`→`runWorkerLoop`→`executeWorkerTool` (the model never supplies it). Part B: new `lib/ai-agent/slack-approval.ts` — `processSlackEvent` intercepts a message that is EXACTLY 6 digits AND from the authorized approver (Antonio / `SLACK_APPROVER_USER_ID`) BEFORE the LLM, finds the single `pending` proposal in this thread (`source_message_id` ∈ agent_messages with matching `slack_scope_key`) + env lane, atomically approves (mirrors `approval_decide` guards) and runs it through the existing `executeApproval` honoring `APPROVAL_RAIL_ENABLED`, editing the ack with the outcome. The code never reaches the model → the loop is structurally impossible. Restricted to Antonio + exact-6-digit only; refuses absent/ambiguous/cross-thread matches. Tests: `tests/unit/slack-approval.test.ts`. See "In-channel approval completion". Prior: 2026-06-18 (DOC-SOURCE READING rail: the Slack worker can now read every internal source Claude Code can read, after it hit "the KB has nothing" while the installment-billing rule lived in a Supabase sysdoc it couldn't see. Four read-only tools added in `worker-tools.ts`, Slack-only (gated by new `CallWorkerOptions.enableDocReads`, set in `processSlackEvent`; kept out of `WORKER_TOOLS` so the Hermes/Telegram research worker never gets them, R108; executor `availableNames` gate is defense-in-depth): `search_sysdocs` (ILIKE over `system_docs` title+body — the missing piece, since the MCP `sysdoc_list`/`sysdoc_read` only list titles + read by exact slug, with no topic search) + `read_sysdoc(slug)` (full content, capped 40k) + `search_sops` (ILIKE over `sop_runbooks` title/service_type/body — find an SOP by topic when you don't know the exact service-type name `get_sop` needs) + `read_drive_file(file_id)` (text via `downloadFileContent`; PDFs/images need the disabled OCR). New SOURCES prompt block tells the worker to search the sysdocs when the KB is empty before saying "no rule / can't find it". Prompt ceiling 8800→9600. Tests: `tests/unit/worker-doc-reads.test.ts` (snippetAround, R108 not-in-WORKER_TOOLS, executor gating, required-param guards). See "Doc-source reading rail". Prior: 2026-06-18 (ANTI-DOUBLE-DOWN + NOUN→TOOL prompt rules added after a live miscount (worker answered "8 May offers" using search_leads/search_deals 'Offer Sent' stage instead of the offers data — real count 15): ENGINEERING DISCIPLINE now says when Antonio pushes back/corrects, re-check with a DIFFERENT tool and recount (never re-run the same query and re-assert), and recount against the rows actually pulled before stating a number; the FULL TOOL REACH block now says match the noun to its dedicated tool — "offers" = use_tool(offer_list), NOT lead/deal pipeline stages. Prompt ceiling test 8000→8800. Prior: 2026-06-18 (ENGINEERING-DISCIPLINE prompt block added to `SLACK_WORKER_SYSTEM_PROMPT` (always on): never assume/invent, CHECK before claiming a tool/capability doesn't exist, challenge the first answer + show both sources on conflict, separate verified from guessed; plus a `find_tool` nudge in the FULL TOOL REACH block — must search the catalog before saying a tool "doesn't exist" (fixes the live "no offers tool exists" stumble). Prompt-size ceiling test bumped 7200→8000. Prior: 2026-06-17 (FLEXIBLE ACTION SURFACE + STEP-CEILING: the Slack worker can reach the whole tool set via `find_tool` + `use_tool` (Slack-only, default OFF via env `ASSISTANT_FULL_REACH_ENABLED`, kept out of `WORKER_TOOLS` so Hermes never gets them, R108): `find_tool` searches the catalog; `use_tool` runs by name through the risk policy — READ auto-runs via the bridge, WRITE/EXTERNAL queue for approval (the approval card on the new `/portal/team/approvals` page is the one-tap surface), blocked refused. The worker loop is now time-aware (250s wall-clock budget + per-call timeout that can't overrun the 300s function cap) and `maxIterations` is 12→20. A FULL TOOL REACH prompt block is appended only when the flag is on. Prior: CALL-READING rail: the Slack worker can now read Circleback calls IN FULL via `list_calls`/`get_call`/`search_calls` — `get_call` returns the COMPLETE transcript (notes + action items + attendees + every speaking turn, not the MCP `cb_get_call` 50-turn preview), gated Slack-only via `enableCallReads` + an executor `availableNames` gate so the Hermes research worker never gets call transcripts (R108); see "Call-reading rail". Prior: 2026-06-15 (EMAIL send rail: the Slack worker can now send a real email via `send_email` after Antonio's explicit "send it" — from support@ or antonio.durante@ (sender selection), with same-thread replies; gated TWO ways (enableEmailSend tool-list injection + an executor-level gate so it can't fire un-gated) so the Hermes worker never gets it (R108); sandbox blocks the actual send via SANDBOX_MODE — real delivery is production-only — see "Email send rail". Earlier same day: TWO GEARS investigation upgrade: the Slack worker now has a QUICK vs DIG-IN prompt — dig-in triggers on investigate/check/diagnose/"why" and restores verify-and-trace discipline (verify each claim, trace behaviour in the code instead of guessing from a column/flag, devil's-advocate, Confirmed/Unconfirmed hand-off for Claude Code) + a hardened read-only `run_sql_query` tool (single-statement SELECT/WITH only, write/DDL blocklist, `auth`+token+password tables blocked, audit-logged, Slack-gated via `enableDbRead`) + `maxIterations` raised to 12 — see "Investigation gear (dig-in)"; prior: 2026-06-13 Slack worker can SEND portal chat messages directly via the new `send_portal_message` tool — Slack-only, no confirmation code, gated by `enableSlackSend` and kept OUT of the shared `WORKER_TOOLS` so the Hermes research worker never gets a client-send tool (R108); fixes Claude proposing an email when Antonio said "send it" on a portal-chat draft — see "Portal-chat send rail"; + code-task progress updates: the Mac Mini runner now posts "🔧 picked it up" right after claiming a code task + one-shot 5-min/10-min "still running" heartbeats around the `claude --print` session, cleared on settle; the queueing Slack worker can't track progress because it runs in a 300 s-capped serverless function that dies on return — see "Code-task rail"; + animated "thinking" indicator: the "On it 👍" ack cycles "🔍 Looking into it…" every 3 s while the worker runs, preserving the Stop button, stopping the moment the row leaves `processing`; on a genuine worker failure the ack is no longer left frozen on the last animation frame — it morphs to "⚠️ Something went wrong on my end — try again or rephrase." with the Stop button dropped, skipped only if the row was already `cancelled` so the "⏹ Stopped" notice is preserved, then the error re-throws so the cron still marks the row `failed`; answer now posts as a NEW thread message for a Slack push notification — ack collapses to "✅" instead of morphing in place; Stop button: "On it 👍" ack now carries a "⏹ Stop" button; new `/api/webhooks/slack-interactions` route cancels the in-flight message; + thread-reply invitation gate: parent-message @mention check replaces channel-level participation query — Claude no longer barges into threads he was never invited to; + ack-collapse + image support + thread-history images + file_share thread replies + message-ts dedup + image-validity guard + text-only fallback + code-task rail auto-push + SHIPPING prompt + shared-thread text context so Claude sees Hermes's messages)
**Owned by:** Antonio Durante LLC — dev

---

## What it does

Always-on Claude presence in Slack. When Antonio writes `@Claude` in any Slack channel or thread, Claude responds conversationally — discuss, investigate, propose — without requiring an open Claude Code session.

**Key behaviors:**
- Immediate "On it 👍" ACK within 1–2 s (Slack's 3-second requirement met every time)
- AI reply 8–15 s later via the worker cron — the worker **posts the answer as a NEW message** (`chat.postMessage`) in the thread, then collapses the "On it 👍" ack to a minimal "✅" (`chat.update`, `blocks: []` to drop the Stop button). A fresh post is what triggers a Slack **push notification** so Antonio knows on his phone that Claude finished — `chat.update` is an edit and Slack does not notify on edits (which is why the old in-place "morph" left him with no signal). Order is post-first: if the fresh post fails (channel error), the worker falls back to morphing the ack into the answer so the reply is never lost.
- **Image attachments**: screenshots attached to a mention are downloaded by the worker (bot token) and passed to sonnet as base64 image blocks (vision). An image-only message (no caption) is accepted. If the current message carries no image but it's a **thread reply**, the worker pulls images from recent **thread history** (`conversations.replies`) — so "read the screenshot" works when the screenshot was posted earlier in the thread. Unsupported media types (HEIC/SVG/BMP) and files >5 MB are skipped; text still answered. See "Image attachments" below.
- Conversational tone (2–5 lines), discuss-before-act, never unilaterally mutates
- Conversation continuity: same channel/thread within 30 min → same `thread_id`
- Accepts `app_mention` events **and** thread-reply `message` events, but a thread reply is only processed if Claude was **invited to that specific thread** — the reply @mentions Claude, or (for a plain reply) the thread's **parent message** @mentioned Claude. A plain reply in someone else's thread (e.g. a Hermes-only thread) is skipped.

---

## Architecture

```
Slack                          Production server              Supabase
──────          ──────────────────────────────────           ────────
@Claude    →    /api/webhooks/slack-claude             →     INSERT agent_messages
                │  1. verify HMAC-SHA256 signature               (status=pending,
                │  2. URL challenge (one-time setup)              sender='slack',
                │  3. skip bots (loop protection)                 recipient='claude',
                │  4. dup guard: event_id THEN message-ts         context_json={…})
                │  5. POST "On it 👍" to Slack         ←  Slack
                │  6. findOrCreateConversationThread
                │  7. INSERT agent_messages row
                └→ fire POST /api/cron/slack-claude-worker?message_id=X  (2.5 s timeout)

/api/cron/slack-claude-worker (*/2 * * * *)
   Direct mode (POST + ?message_id):
     claimPending (UPDATE WHERE status='pending' RETURNING) → processSlackEvent
   Scan mode (GET):
     recoverStaleClaims (processing rows > 10 min) → pick ≤5 pending Slack rows
```

---

## Key files

| File | Role |
|------|------|
| `lib/ai-agent/slack-claude.ts` | Core module: `SLACK_WORKER_SYSTEM_PROMPT`, `slackScopeKey`, `postSlackMessage`, `updateSlackMessage`, `findOrCreateConversationThread`, `processSlackEvent`, `prepareSlackImages`, `fetchThreadImages` (thread-history image harvest), `fetchThreadHistory` (thread-history **text** harvest for shared-thread context), `buildThinkingBlocks` / `verifySlackSignature` / `parseSlackInteraction` / `STOP_THINKING_ACTION_ID` (Stop button) |
| `lib/ai-agent/slack-approval.ts` | In-channel approval completion: `isSixDigitCode`, `isAuthorizedApprover`, `approvalScopeKey`, `handleSlackApprovalCode`. Reuses `approval-executor.ts` (`executeApproval`, `isApprovalRailEnabled`) — does NOT fork it |
| `app/api/webhooks/slack-claude/route.ts` | Slack Events API webhook handler (posts the "On it 👍" ack with the Stop button) |
| `app/api/webhooks/slack-interactions/route.ts` | Slack interactive-components webhook — handles the "⏹ Stop" button click |
| `app/api/cron/slack-claude-worker/route.ts` | Worker cron (direct trigger + scan safety net) |
| `scripts/mac-mini/code-task-runner.mjs` | Mac Mini launchd daemon: claims `recipient='code_runner'` rows, posts "🔧 picked it up" + live tool-activity milestones + 5/10-min heartbeats, runs headless `claude --print --output-format stream-json --verbose`, auto-pushes new commits to production, posts result to the Slack thread |
| `scripts/mac-mini/code-task-progress.mjs` | Pure stream-json parser used by the runner: maps assistant `tool_use` events → coarse Slack milestones (editing / building / testing / committing), and reads the final answer + `is_error` flag from the terminal `result` event. Unit-tested in `tests/unit/code-task-progress.test.ts` |
| `scripts/mac-mini/ask-antonio.mjs` | CLI the headless session runs to ask Antonio a blocking question in Slack and wait for his reply (the ask-antonio loop). Inserts a `code_task_questions` row, posts the question, polls until answered/expired |
| `scripts/mac-mini/ask-antonio-lib.mjs` | Pure helpers for the ask-antonio CLI (Slack text format, answer cleaning, poll-row interpretation, Antonio's user id). Unit-tested in `tests/unit/ask-antonio-lib.test.ts` |
| `scripts/migrations/20260610-1400-slack-claude-party.sql` | Adds `'slack'` to `agent_message_party` enum |
| `tests/unit/slack-claude-worker.test.ts` | Unit tests |

---

## DB tables

| Table | Usage |
|-------|-------|
| `agent_messages` | One row per Slack mention. `sender='slack'`, `recipient='claude'`, `context_json.source='slack'`. Status lifecycle: `pending → processing → done / failed`. |
| `thread_summaries` | One row per conversation scope. Created by `findOrCreateConversationThread` when a new 30-min window opens. |
| `code_task_questions` | One row per ask-antonio question (`pending → answered / expired`). Written by the ask-antonio CLI (insert + poll), answered by the Slack webhook (Antonio's thread reply), expired by the runner on task settle. Migration `scripts/migrations/20260612-1900-code-task-questions.sql`. |

### context_json keys on agent_messages rows

```json
{
  "source": "slack",
  "slack_event_id": "Ev01234ABC",
  "slack_channel_id": "C0BAB08DSDN",
  "slack_thread_ts": "1234567890.000100",
  "slack_event_ts": "1234567890.000200",
  "slack_scope_key": "C0BAB08DSDN:1234567890.000100",
  "slack_user_id": "U0ANTONIO",
  "slack_ack_ts": "1234567890.000300",
  "slack_images": [{ "url": "https://files.slack.com/…", "name": "screenshot.png", "mimetype": "image/png", "size": 84211 }]
}
```

- `slack_ack_ts` — ts of the "On it 👍" message; the worker `chat.update`s this into the final answer. `null` if the ack post failed → worker posts a fresh reply.
- `slack_images` — supported image attachments (filtered to `image/jpeg|png|gif|webp`, ≤5 MB) the webhook saw. `url` is Slack's `url_private`, fetched by the worker with the bot token (NOT in the webhook — downloading there risks the 3 s ACK). `[]` when none.

---

## Env vars required

| Var | Where | What |
|-----|-------|------|
| `SLACK_BOT_TOKEN_CLAUDE` | Vercel (both envs) | Bot OAuth token for the Claude Slack app (`A0B9LUJRLMB`), starts with `xoxb-` |
| `SLACK_SIGNING_SECRET_CLAUDE` | Vercel (both envs) | Signing secret from Slack app Basic Information page — used for HMAC request verification |
| `CRON_SECRET` | Vercel (both envs) | Shared secret for webhook → cron direct-trigger auth (same as hermes-bridge) |
| `SLACK_APPROVER_USER_ID` | Vercel (optional) | Slack user id allowed to complete approvals in-channel. Defaults to Antonio's id `U0BAALR4Y4Q` when unset. Set to rotate the approver. |
| `APPROVAL_RAIL_ENABLED` | Vercel | Kill switch for the approval executor (must be `'true'` to RUN approved actions). In-channel approve still flips the row to `approved` when off; it just won't execute until re-enabled. Shared with the Hermes rail. |

**Never commit these to git.**

---

## Accepted events

The webhook processes:
- `app_mention` — Antonio @mentions Claude (any channel/context). Always processed.
- `message` events that are (a) inside a thread (`thread_ts` set), (b) have **no** `subtype` **or** `subtype="file_share"` (genuine human text, or a pure screenshot drop with no @mention — Slack tags file uploads as `file_share`; all other subtypes `bot_message`/`message_changed`/`message_deleted`/joins are still excluded so edits/deletes/joins don't re-trigger), **and** (c) pass the **thread-reply invitation gate** below.

### Thread-reply invitation gate (`route.ts`, the `isThreadReply && !isAppMention` block)

A thread reply is only processed if Claude was actually invited to **that specific thread**. Three cases, in order:

1. The reply itself @mentions Claude (`<@U0B9S675WTT>`) → **process** (explicit).
2. The reply @mentions someone else but **not** Claude (e.g. `@Hermes`) → **skip** (`directed_at_other`).
3. The reply has **no** @mention at all → fetch the thread's **parent (root) message** via `conversations.history?latest=<thread_ts>&inclusive=true&limit=1` and process **only if the parent text contains `<@U0B9S675WTT>`**; otherwise the thread belongs to someone else → **skip** (`not_invited`). Parent-fetch failure (missing token/scope, network, not found) defaults to skip — the safe default, since the bug being guarded is over-responding.

A top-level `@Claude` that opens a thread roots that thread at the mention message, so its later plain replies see parent-mention = true and continue the conversation. **Behavior change (2026-06-12):** the old gate used a channel-level participation query (`agent_messages` row with matching thread-level **or** bare `channelId` `slack_scope_key`). The bare-channel match leaked — once Claude had spoken at the top level of a channel, every plain reply in *any* thread of that channel matched and Claude barged in (notably Hermes-only threads). The parent-mention check scopes "invited" to the actual thread. Trade-off: if Claude was mentioned *mid-thread* of a non-Claude-rooted thread, a later *plain* reply is no longer answered — re-mention to continue.

All other event types are ACK'd with `{ ok: true }` and ignored.

## Duplicate-event protection (two layers)

Slack can deliver more than one event for a single underlying message, so the webhook dedups twice before inserting an `agent_messages` row:

1. **By `event_id`** (`isDuplicateEvent`) — catches Slack's own 3-second retry of the *same* event (same `event_id`).
2. **By message ts** — catches the case where Slack fires **two different events for the same message**: when Antonio @mentions Claude in a thread Claude already joined, Slack sends both an `app_mention` **and** a `message` event with *different* `event_id`s but the *same* `event.ts`. The event_id layer misses this (two distinct ids); the ts layer matches on `context_json->>slack_event_ts` + `slack_channel_id`, so whichever event arrives first inserts and the second is dropped (`{ ok: true, dedup: "message_ts" }`). Without it, one @mention produced a double "On it 👍" and double processing.

> Both layers are SELECT-then-INSERT with no DB unique constraint, so a true simultaneous race could still slip two rows through — Slack delivers the paired events sequentially, so this mitigates the real-world case. A unique index is the hardening option if doubles ever reappear.

## Image attachments

- **Webhook** (`route.ts`): reads `event.files`, keeps only `image/jpeg|png|gif|webp` within the 5 MB cap (`SLACK_SUPPORTED_IMAGE_TYPES` / `SLACK_MAX_IMAGE_BYTES` in `slack-claude.ts`), stores `{url,name,mimetype,size}[]` as `context_json.slack_images`. The text guard is relaxed to accept a message with **text OR ≥1 image**, so an image-only screenshot isn't dropped. Image-only body falls back to `"(image attached — no caption)"`. The thread-reply gate accepts `subtype="file_share"` so a pure screenshot dropped into a thread (no @mention) is processed rather than silently ignored.
- **Worker — current message** (`prepareSlackImages` in `slack-claude.ts`): downloads each url_private with `SLACK_BOT_TOKEN_CLAUDE`, **validates the downloaded bytes are a real image via magic-byte check** (PNG `89 50`, JPEG `FF D8`, GIF `47 49`, WEBP `"WEBP"` at offset 8), re-checks the 5 MB cap on the actual bytes, base64-encodes, returns `WorkerImageBlock[]`. Best-effort: a bad type / **non-image body (e.g. an HTML login page returned with a 200 when the bot lacks `files:read`)** / oversize / 401 / missing token skips that one image (logged), the reply still goes out. The magic-byte guard is what stops a login-page HTML blob from being base64'd and crashing the whole Anthropic call.
- **Worker — text-only fallback** (`processSlackEvent` in `slack-claude.ts`): the `callWorker` call is wrapped in try/catch. If it throws an **image-related 400** (error message contains both `400` and `image`, and images were attached), the worker retries **once without images** so Antonio still gets a text answer instead of a silent failure. Any other error (non-image, or no images attached) is re-thrown unchanged so the cron marks the row `failed` as before. This is the backstop for an image that slips past the magic-byte guard or an edge media type the API rejects at call time.
- **Worker — thread history fallback** (`fetchThreadImages` in `slack-claude.ts`): when `context_json.slack_images` is empty **and** the row is a thread reply (`slack_thread_ts` set), the worker calls `conversations.replies` (≤20 messages) and harvests any supported images from earlier in the thread, then feeds them through `prepareSlackImages`. This is what makes "read the screenshot" work when the screenshot was posted in a prior message. Best-effort: missing token / non-ok response (e.g. missing `channels:history` scope) / network error returns `[]` and the worker answers text-only. **Requires the bot to hold `channels:history` (and `groups:history` for private channels) read scope** — verify in prod E2E.
- **callWorker** (`worker-tools.ts`): `opts.images` is optional. When non-empty the user turn is sent as `[{type:"text",…}, …imageBlocks]`; otherwise a plain string — identical to the Hermes/Telegram path. `runWorkerLoop` accepts `string | content[]`.

## Shared-thread context (Claude sees Hermes's messages)

When Antonio tags **both** `@Claude` and `@Hermes` in a thread, the worker would otherwise only have `row.body` (the current message) + Claude's own `agent_messages` memory — it never sees what Hermes said. The fix injects the real Slack transcript:

- **`fetchThreadHistory(channelId, threadTs, limit=30)`** (`slack-claude.ts`): calls `conversations.replies` and formats each message as `Sender: text [+N file(s)]`. Skips Claude's own messages (user id `U0B9S675WTT` — already in its agent_messages context). Labels by user id: Antonio `U0BAALR4Y4Q`, Hermes `U0B9D3MAD9B`, any `bot_id` → `Bot`, else `Someone`. Rewrites `<@ID>` mention tokens to readable `@Claude`/`@Hermes`/`@Antonio`. Best-effort: missing token / non-ok response (e.g. missing `channels:history` scope) / network error → returns `""` and the worker uses `row.body` unchanged.
- **`processSlackEvent`** gates the fetch on the genuine thread ts (`context_json.slack_thread_ts`), same gate as the thread-image fallback — a brand-new top-level mention has no prior thread to read (and would fire a useless `conversations.replies` call). When history is non-empty the worker body becomes:
  ```
  [SLACK THREAD CONTEXT — what others said in this thread]
  Antonio: …
  Hermes: …

  [YOUR CURRENT MESSAGE]
  <row.body>
  ```
- **System prompt** carries a `SHARED THREADS` block telling Claude to read the context, not repeat what Hermes already answered, and — if Antonio says "send it" after Hermes drafted something — acknowledge Hermes already sent it rather than asking "to who?".
- Antonio's user id `U0BAALR4Y4Q` is **not otherwise referenced in code** (supplied by Antonio); a wrong id only degrades his label to `Someone`, never the flow. Claude `U0B9S675WTT` + Hermes `U0B9D3MAD9B` are cross-checked against `app/api/webhooks/slack-claude/route.ts`.
- **Requires the bot to hold `channels:history`** (and `groups:history` for private channels) read scope — same scope the thread-image fallback needs. Verify in prod E2E.

## Human-tone client drafts (no asterisks)

Added 2026-06-19. Antonio wanted the worker's **client-facing drafts** (emails + portal messages) to stop using markdown asterisks and read like a person, not an AI. Scoped to drafts only — the worker's own Slack chat replies still use `*bold*`.

- **Prompt layer:** a `DRAFTS` block in `SLACK_WORKER_SYSTEM_PROMPT` (`slack-claude.ts`) — email bodies + portal messages must be natural human prose, NO asterisks / markdown / `#` headers / bullet-dumps, with an explicit carve-out that Slack replies to the team may still use `*bold*`.
- **Hard sanitizer (belt-and-suspenders):** pure `stripDraftMarkdown(text)` (`worker-tools.ts`, exported + unit-tested) guarantees zero asterisks even if the model ignores the prompt — unwraps bold/italic asterisk pairs, converts line-start `* ` bullets to `- `, strips any stray `*`. Applied in `executeWorkerTool` ONLY on the worker's client-send paths: `send_email` (sanitizes `body` + `subject` before delegating to the shared `send_email` AGENT tool) and `sendPortalMessageFromWorker` (sanitizes `message` before the dedup/insert/notify).
- **NOT sanitized:** the shared `send_email` AGENT tool itself and the in-dashboard agent — the sanitizer lives in the worker dispatch, so other system senders are untouched. The worker's Slack chat output is untouched (different surface).
- **Tests:** `tests/unit/worker-draft-sanitizer.test.ts` (zero-asterisk guarantee, bullets→dashes, plain text unchanged, empty-safe); prompt-shape assertion in `tests/unit/slack-claude-worker.test.ts`.

## Referenced-thread reach (shared messages + pasted archive links)

Added 2026-06-19. Before this, the worker could only read the thread it was replying in. When Antonio **shared** Luca's request onto a `@Claude` post (or pasted a Slack archive link), the worker never saw it — the webhook captured only `event.text`, dropping the shared content at the front door — so Claude replied "I don't see the request, paste it."

- **Two reference sources, parsed purely (no Slack call):**
  - **Shared message** — Slack's "Share message" action delivers an `attachment` carrying the source `channel_id` + `ts` (+ `from_url`, from which an explicit `thread_ts` is recovered). `parseSlackShareAttachments`.
  - **Pasted archive link** — `…/archives/<C|G|D…>/p<digits>?thread_ts=…` in the message text. `parseSlackArchiveLinks` (uses `pTimestampToTs` to turn the `p` number into a dotted ts; recovers `thread_ts` from the query, else falls back to the message ts).
  - `collectSlackReferences({text, attachments})` merges both, dedupes by `channel:thread_ts`, caps at `MAX_SLACK_REFERENCES` (3). All pure + exported, unit-tested.
- **Webhook** (`route.ts`): calls `collectSlackReferences` and stores the result as `context_json.slack_referenced` (`[]` when none). Pure parsing only — no Slack API call — so it can't threaten the 3 s ACK deadline (same discipline as image refs).
- **Worker** (`processSlackEvent`): merges `ctx.slack_referenced` with a re-parse of `row.body` (link safety-net for rows where the webhook saw no attachment / the unfurl arrived async), then `fetchReferencedThreads(refs, currentThreadTs)` fetches each source thread via `conversations.replies` (reusing `fetchThreadHistory` with a `charCap`), **skipping any ref equal to the current thread** (no double-injection), and injects a `[REFERENCED SLACK THREAD(S) — shared into this conversation…]` block ahead of `[YOUR CURRENT MESSAGE]`.
- **Caps (worker-side, protect the model's input budget — every char is re-sent each loop step):** `REFERENCED_THREAD_MSG_LIMIT=30` messages, `REFERENCED_THREAD_CHAR_CAP=8000` chars (truncates with a note). NOT a Slack limit.
- **Best-effort:** missing token / bot not a member of the referenced channel / deleted message / network error → that ref is skipped, the worker still answers. Requires the same `channels:history`/`groups:history` scope as the existing thread-history fetch — and the bot must be a member of the referenced channel.
- **Tests:** `tests/unit/slack-claude-worker.test.ts` (the four parsers, `fetchReferencedThreads` incl. the current-thread skip, and the processSlackEvent injection).

## Step-limit convergence (no more "I reached my working limit" with no answer)

Added 2026-06-19. `runWorkerLoop`'s tool loop ends when it hits `maxLoops` (20 for Slack) **or** the 250 s wall-clock budget. Previously, if the model never emitted a final text answer before that, the worker returned a generic *"I reached my working limit (up to 20 steps)…"* — i.e. an investigative question (which legitimately chains many read tools) got **no answer at all** (this is exactly what happened to Luca's "is there a way the client can drill into a P&L line?" question).

- **Fix:** on loop exhaustion, before returning the generic message, `runWorkerLoop` makes **one final NO-TOOLS call** — it appends an "answer now with what you found" nudge to the last (unsent) tool-result turn and re-calls the model with `tools` omitted, forcing a text reply. That synthesized answer is returned (`reachedMaxLoops` stays `true` for telemetry).
- **Guarded:** the synthesis call only fires if there's wall-clock budget left (`< WORKER_WALL_CLOCK_BUDGET_MS − CALL_DEADLINE_MARGIN_MS`), and its own timeout shrinks via `callTimeoutForBudget`, so it can never push the function past `maxDuration`. On any failure or empty reply it falls back to the original generic message.
- `runWorkerLoop` is now **exported** so the branch is directly unit-testable. Tests: `tests/unit/worker-loop-convergence.test.ts` (forced synthesis returns the answer + the synthesis call omits `tools`; fallback to the generic message on synthesis failure; a normal `end_turn` needs no synthesis call).

## Loop protection

The webhook handler skips incoming events (runs **before** the invitation gate and insert) when:
- `event.bot_id` is set (any bot) — this is what stops Claude's own posted replies (which carry `bot_id`) from re-triggering
- `event.user === "U0B9S675WTT"` (Claude's own user ID)
- `event.subtype === "bot_message"`

---

## Conversation scope logic

`slackScopeKey(channelId, threadTs)`:
- Top-level message → key = `channelId`
- Threaded reply → key = `channelId:threadTs`

`findOrCreateConversationThread(channelId, threadTs)`:
1. Query `agent_messages` where `created_at > now - 30 min` AND `thread_id IS NOT NULL`
2. **First pass** — exact match on `context_json.slack_scope_key`
3. **Second pass** (only when `threadTs` is set) — match the channel-level scope (`channelId` with no thread_ts) that started the conversation. This is the fix for the channel→thread key drift: a channel-level mention stores `scope_key = channelId`, but its follow-up reply arrives with `thread_ts` set (`scope_key = channelId:thread_ts`). Prefer the channel-level row whose `slack_event_ts === threadTs` (exact thread-origin link); otherwise fall back to the most recent channel-level row in the window.
4. If found in either pass → reuse that `thread_id` (conversation continuity)
5. If not → generate new UUID, call `createThreadSummary`, return it

> **Edge case:** the channel-only fallback (no exact ts match) picks the *most recent* channel-level row. Two separate channel-level conversations in the same channel within 30 min, then a reply in the older one with no precise ts match, could attach to the newer conversation's memory. Bounded by the 30-min window and serial 1:1 usage.

---

## System prompt

`SLACK_WORKER_SYSTEM_PROMPT` in `lib/ai-agent/slack-claude.ts`:
- Short, conversational (2–5 lines max)
- Discuss-before-act: report findings, ask what to do next, never self-approve actions
- `propose_action` pattern: describe in plain English → wait for explicit approval ("yes", "go", "send it")
- **CODE TASKS** block: when asked to implement/build/fix/deploy → investigate with read tools, then call `start_code_task` with detailed instructions, then say "I've queued the task — Mac Mini will handle it and report back here"
- **SHIPPING** block: when Antonio says "ship it"/"deploy it"/"push it" → don't re-queue a done code task (the runner auto-pushes); if a local commit is waiting, say "The code is committed and being pushed to production"; "ship" = push to production, "do it" = implement — don't confuse the two
- **PORTAL CHAT REPLIES** block: to reply to a client in portal chat, after Antonio's explicit "send it", call `send_portal_message` (account_id for an LLC, or contact_id for a person) — it posts in the client's portal, NOT an email; never propose an email for a portal chat reply (see "Portal-chat send rail" below)
- **SHARED THREADS** block: read Hermes's messages from the injected thread context, don't repeat what Hermes already answered, acknowledge Hermes already sent something rather than asking "to who?" (see "Shared-thread context" above)
- Differs from `WORKER_SYSTEM_PROMPT` (Hermes): less analytical, more interactive
- **TWO GEARS** block (2026-06-15): QUICK (default — one lookup, 2–5 lines) vs DIG IN (triggered when Antonio asks to investigate/check/diagnose/audit or asks "why"). Dig-in tells the worker to chain as many read-only lookups as needed, use `run_sql_query` + `codebase_read`/`codebase_search` to **verify against the real data and trace how a feature behaves instead of guessing from a column/flag**, be its own devil's advocate, and end with a Confirmed / Unconfirmed hand-off so findings go straight to Claude Code. Plus a SENSITIVE DATA rule (never paste raw secrets/tokens/passwords into Slack). See "Investigation gear" below.

---

## Investigation gear (dig-in) + read-only SQL (`run_sql_query`)

Added 2026-06-15 after the Slack worker mis-diagnosed a client portal question — it guessed from a single DB column (`portal_account`) instead of tracing the switcher code, because its prompt told it to do the *minimum* lookup and it had no raw-DB access. Goal: a Slack client question can be investigated deeply enough that the findings are a trustworthy hand-off into Claude Code.

- **Two gears, prompt-driven.** `SLACK_WORKER_SYSTEM_PROMPT` now distinguishes QUICK (status/chitchat — one lookup, brief) from DIG IN (investigate/check/diagnose/"why"). Dig-in restores the verify-and-trace discipline the conversational prompt had dropped: verify every claim with a fresh tool call, trace behaviour in the code (`codebase_read`/`codebase_search`) rather than inferring from a column, be the devil's advocate, and label Confirmed vs Unconfirmed in the reply.
- **Read-only SQL tool.** `RUN_SQL_QUERY_TOOL` (`run_sql_query`) + `runReadOnlySqlForWorker()` in `lib/ai-agent/worker-tools.ts` reach data the canned `search_*` tools can't (e.g. `account_contacts` links, `ss4_applications`, `service_deliveries`, portal tier/flags). Hardened beyond the in-dashboard `runSqlQuery`: the pure validator `assertWorkerReadOnlySql` enforces **single statement only**, **SELECT/WITH only**, a **write/DDL keyword blocklist** (also catches write-CTEs), and **blocks the `auth` schema + token/password tables** (`auth.*`, `oauth_*`, `qb_tokens`, `push_subscriptions`, `encrypted_password`) so login hashes/tokens can never be read into a Slack reply. It then runs via the **DB-enforced `exec_sql_readonly` RPC** (`transaction_read_only=on` + server-side credential-table block + `LIMIT 500` + 8s timeout) — strictly safer than the in-dashboard `exec_sql`. Every accepted query is audit-logged (`action_log`, actor `claude.slack`); output is capped (`WORKER_SQL_RESULT_CAP`).
- **Gating (R108 safety):** `run_sql_query` is **NOT** in the shared `WORKER_TOOLS`, so the Hermes/Telegram research worker never gets raw SQL. It is injected only when `CallWorkerOptions.enableDbRead` is true — set only by `processSlackEvent` (alongside `enableCodeTasks`/`enableSlackSend`). `executeWorkerTool` dispatches it before the read-only guard. Same gating pattern as `send_portal_message` / `start_code_task`.
- **Loop budget.** `processSlackEvent` raises `maxIterations` to 12 (from the default 8) so a real investigation isn't cut off mid-dig.
- **Tests:** `tests/unit/worker-sql-readonly.test.ts` (guard accepts SELECT/WITH, rejects writes/DDL/stacked/CTE-writes/auth+token tables, + the `WORKER_TOOLS`-exclusion invariant). The prompt-bloat ceiling in `tests/unit/slack-claude-worker.test.ts` was raised to 5600 for the TWO GEARS block.

---

## Portal-chat send rail (`send_portal_message`)

The Slack worker is the **only** worker with a direct (no-confirmation-code) client-facing send. Authorized by Antonio 2026-06-13: a portal chat reply is a routine, low-stakes action, and the "approval" is his explicit "send it" in the Slack thread after Claude shows the draft. Every other side-effecting capability still routes through `propose_action` → `approval_queue` → confirmation code.

- **Where it lives:** `SEND_PORTAL_MESSAGE_TOOL` + `sendPortalMessageFromWorker()` in `lib/ai-agent/worker-tools.ts`. The send mirrors the MCP `portal_chat_send` tool: insert into `portal_messages` as `sender_type='admin'` (sender_id = Antonio's auth id), resolve a contact from the account when only `account_id` is given, then fire `createPortalNotification` + `notifyClientOfAdminMessage` (in-portal alert + client email, both fire-and-forget). Plus one extra guard the MCP tool lacks: a **2-minute same-recipient+same-text dedup** so an LLM retry / cron reprocess can't double-post.
- **Gating (R108 safety):** the tool is **NOT** in the shared `WORKER_TOOLS` array — `WORKER_TOOLS` also feeds the Hermes/Telegram research worker, which must stay research-only. It is injected into the tool list **only when `CallWorkerOptions.enableSlackSend` is true**, which only `processSlackEvent` sets (alongside `enableCodeTasks`). Same pattern as `START_CODE_TASK_TOOL`. `executeWorkerTool` dispatches `send_portal_message` explicitly, before the read-only guard.
- **Why it exists:** before this, the Slack worker had no portal-send tool, so when Antonio approved a portal-chat draft and said "send it", the only reachable send was `propose_action(send_email)` — Claude proposed an **email** instead of sending the portal message. The PORTAL CHAT REPLIES prompt block now points it at `send_portal_message`.
- **Tests:** `tests/unit/slack-portal-send.test.ts` (send logic + the `WORKER_TOOLS`-exclusion invariant).

---

## Email send rail (`send_email`)

Added 2026-06-15. Lets the Slack worker send a real email after Antonio's explicit "send it", mirroring the portal-chat send rail.

- **Where it lives:** `SEND_EMAIL_TOOL` in `lib/ai-agent/worker-tools.ts`, dispatched in `executeWorkerTool` → delegates to the shared `send_email` AGENT_TOOL (`lib/ai-agent/tools.ts`). The shared tool now supports **sender selection**: `from:'support'` (support@tonydurante.us, default) or `from:'antonio'` (antonio.durante@tonydurante.us). It already supported **same-thread replies** via `reply_to_message_id` (In-Reply-To/References + threadId); the threading read and the send now both run as the chosen mailbox so a reply stays in the thread that lives in that inbox.
- **Gating (R108 safety) — TWO layers:** (1) tool-list: `SEND_EMAIL_TOOL` is NOT in `WORKER_TOOLS`; it is injected only when `CallWorkerOptions.enableEmailSend` is true, which only `processSlackEvent` sets — so the Hermes/Telegram research worker never gets it. (2) executor: `executeWorkerTool` refuses `send_email` unless it was actually offered to the model this call (`availableNames.has('send_email')`), so a real external send can never fire un-gated even if the model names it. Tested in `tests/unit/agent-bridge-worker-tools.test.ts`.
- **Discipline (prompt):** the EMAIL block in `SLACK_WORKER_SYSTEM_PROMPT` requires showing the full draft (from / to / subject / body / thread) and sending ONLY after Antonio's explicit "send it" — same rule as portal chat / `gmail_send` (R108).
- **Sandbox constraint:** `lib/gmail.ts` blocks all `/messages/send` when `SANDBOX_MODE=1` (returns a mock success, logs `[SANDBOX] Email blocked`). So real delivery + threading are verifiable only in production — sandbox confirms sender routing + the gates but cannot actually send.

---

## Call-reading rail (Circleback: `list_calls` / `get_call` / `search_calls`)

Added 2026-06-17. Lets the Slack worker read recorded calls (Circleback — sales/intake/client calls stored in `call_summaries`) IN FULL, so it can ground a client answer in what was actually said.

- **Where it lives:** `LIST_CALLS_TOOL` / `GET_CALL_TOOL` / `SEARCH_CALLS_TOOL` + their handlers (`listCallsForWorker` / `getCallForWorker` / `searchCallsForWorker`) and the pure renderer `renderCallDetail()` in `lib/ai-agent/worker-tools.ts`, dispatched in `executeWorkerTool`. Read-only Supabase selects on `call_summaries`.
- **Full transcript, not a preview:** `get_call` returns the COMPLETE word-for-word transcript (every speaking turn) plus notes, action items, attendees, recording URL — **not** the 50-turn cap that the MCP `cb_get_call` tool applies. Only a generous char cap (`CALL_RESULT_CAP` = 120k) protects the worker's token budget; on overflow it truncates with a pointer to the recording. This is deliberate — Antonio wants every detail of every call. The MCP `cb_get_call` 50-turn cap is left untouched (independent).
- **Gating (R108 safety) — TWO layers:** (1) tool-list: the three tools are NOT in `WORKER_TOOLS`; injected only when `CallWorkerOptions.enableCallReads` is true, which only `processSlackEvent` sets — so the Hermes/Telegram research worker never gets call transcripts (sensitive client content). (2) executor: `executeWorkerTool` refuses `list_calls`/`get_call`/`search_calls` unless offered this call (`availableNames.has(name)`). Tested in `tests/unit/worker-call-reads.test.ts`.
- **Discipline (prompt):** the CALLS block in `SLACK_WORKER_SYSTEM_PROMPT` tells the worker to resolve a client to an `account_id`/`lead_id` via CRM search first, then `list_calls`/`search_calls` → `get_call`, and to summarize/quote key lines for Slack rather than paste an entire transcript.

---

## Doc-source reading rail (`search_sysdocs` / `read_sysdoc` / `search_sops` / `read_drive_file`)

Added 2026-06-18. Gives the Slack worker read parity with the internal sources Claude Code can read. Built after the worker told Antonio "the KB has nothing" on installment-billing timing — when the authoritative rule actually lived in the Supabase sysdoc `invoicing-2026-second-installment-rules-and-cleanup`, which the worker had no tool to reach.

- **The gap it closes:** the worker already searched the KB (`search_kb`), SOPs by exact service type (`get_sop`), the repo (`codebase_read`/`search`), and the DB (`run_sql_query`). It could NOT: search the 143 `system_docs` (no tool at all — `sysdoc_list` only lists titles and `sysdoc_read` needs an exact slug, so there was no topic search), find an SOP by topic, or read a Drive file's text.
- **Where it lives:** `SEARCH_SYSDOCS_TOOL` / `READ_SYSDOC_TOOL` / `SEARCH_SOPS_TOOL` / `READ_DRIVE_FILE_TOOL` + handlers (`searchSysdocsForWorker` / `readSysdocForWorker` / `searchSopsForWorker` / `readDriveFileForWorker`) and the pure helper `snippetAround()` in `lib/ai-agent/worker-tools.ts`, dispatched in `executeWorkerTool`. `search_sysdocs` ILIKEs `system_docs` title+body and returns slug+snippet → `read_sysdoc(slug)` returns full content (capped `DOC_RESULT_CAP` = 40k). `search_sops` ILIKEs `sop_runbooks` title/service_type/body (top match full). `read_drive_file` wraps `downloadFileContent` from `lib/google-drive` (text/CSV/Docs/Sheets; PDFs/images need the currently-disabled OCR — it reports the file type instead).
- **Gating (R108 safety) — TWO layers:** (1) tool-list: the four tools are NOT in `WORKER_TOOLS`; injected only when `CallWorkerOptions.enableDocReads` is true, which only `processSlackEvent` sets — so the Hermes/Telegram research worker never gets them. (2) executor: `executeWorkerTool` refuses the four names unless offered this call (`availableNames.has(name)`). All read-only. Tested in `tests/unit/worker-doc-reads.test.ts`.
- **Discipline (prompt):** the SOURCES block in `SLACK_WORKER_SYSTEM_PROMPT` tells the worker that many authoritative rules (billing/installment timing, formation flow, decisions, current system state) live in the sysdocs, NOT the KB — and that before saying "there's no rule / I can't find it" it MUST search the sysdocs (`search_sysdocs` → `read_sysdoc`, `'session-context'` for current state).

---

## Code-task rail (`start_code_task` → Mac Mini → review branch → `ship it` promote)

When the Slack worker calls `start_code_task` it inserts an `agent_messages` row with `recipient='code_runner'`, carrying `context_json.{source,title,slack_channel_id,slack_thread_ts}` so the result can be posted back to the originating thread.

`scripts/mac-mini/code-task-runner.mjs` is a launchd daemon on the Mac Mini that polls every 15 s for the oldest `recipient='code_runner'` + `status='pending'` row, atomically claims it (`status pending → processing`), and runs a headless `claude --print` session with full access.

**Per-task ISOLATION (added 2026-06-13):** the runner no longer runs the session on the shared `main` checkout. For each task it creates its own git worktree on its own branch cut from the current `origin/main` — `prepareWorktree()` → `git fetch origin main` + `git worktree add .claude/worktrees/code-task-<short8> -b code-task/<short8>-<slug> origin/main`, with `node_modules` symlinked from the main checkout so the pre-push hooks have their deps. The session runs with `cwd` = the worktree. So a task only ever sees and commits its OWN changes and can never mix with, or clobber, another session's in-flight work (no shared `main`, no `reset --hard`, no stash collisions, concurrent tasks safe). `cleanupWorktree()` tears the worktree down after; `sweepOrphanWorktrees()` at startup clears any orphaned by a crashed run. Helpers (branch name / worktree path / repo+compare URL / promote names) are pure in `scripts/mac-mini/deploy-utils.mjs`, unit-tested in `tests/unit/code-task-deploy-utils.test.ts`.

**Review branch, NOT auto-deploy (changed 2026-06-13, R104):** after a *successful* session that left commits, the runner pushes the task's BRANCH (`git push -u origin code-task/...` from the worktree — never `main`), records `context_json.code_branch` on the row, and posts the branch + a compare/PR link with "Reply 'ship it' to promote to production." Because the branch was cut from `origin/main`, it holds ONLY this task's commits — surgical. The pre-push hooks (build/tests/lint/R107 doc gate/remote-sync) run on the branch push, so a broken change never reaches a reviewable branch. **The rail no longer auto-ships to production.** Both build-gated pushes — the branch push here and the `ship it` promote-to-`main` push — use `execSync` with `timeout: GATED_PUSH_TIMEOUT_MS` (10 min), NOT the old 120 s: the pre-push gate runs `next build` + the full test suite, which exceeds 2 minutes, so the old cap killed the push mid-build with `spawnSync /bin/sh ETIMEDOUT` and falsely failed the task even though the commits were valid (Fax History task, 2026-06-20). 10 min sits inside the 30-min task SIGKILL.

**`ship it` promotion:** when Antonio says "ship it" in the thread, the Slack worker calls the `promote_code_branch` tool → it finds that thread's last completed task's `code_branch` and queues a promote task (`context_json.promote_branch`). The runner's `promoteBranchToMain()` merges that one branch into the CURRENT `origin/main` in an isolated worktree and runs `ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA=1 git push origin HEAD:main` — the ONLY place the rail deploys to production, gated on the explicit human "ship it". If `main` has advanced and the branch conflicts, the merge is aborted and NOTHING is pushed (reported as needs-rebase) — never a force-merge.

**Progress updates (added 2026-06-12):** the runner now posts live status to the originating thread so the user isn't left in silence between "I've queued the task" and the final result. Right after the atomic claim it posts "🔧 *<title>* — Mac Mini picked it up, working on it…"; it then arms two one-shot heartbeat timers (`HEARTBEATS`: 5 min "⏳ Still running", 10 min "⚠️ Taking longer than expected") around `runClaude`, cleared the moment the session settles — so a sub-5-min task posts none. The terminal ✅ done / ⚠️ failed post is unchanged.

**Fine-grained milestones (added 2026-06-12, stream-json):** the runner invokes the session with `--output-format stream-json --verbose` and parses the NDJSON event stream in real time via the pure helpers in `code-task-progress.mjs`. Each assistant `tool_use` maps to a coarse milestone posted to the thread — "🔍 Reading the code…" (Read/Grep/Glob/LS), "✏️ Editing code…" (Edit/Write), "🔨 Building…" / "🧪 Running tests…" / "💾 Committing…" (Bash, sub-classified by command), "🤖 Running a sub-agent…" (Task) — **deduped against the previous milestone** so a burst of reads/edits collapses to one line, but a phase that recurs after another (edit → test → edit) is re-posted to show the retry loop. The session's own `git push` tool_use is intentionally suppressed (returns null) because the runner narrates the push phase itself ("📦 Pushing to branch `code-task/…` for review…"). The heartbeats remain as the long-silence fallback. **Final-answer source changed:** with stream-json, stdout is the event stream, not the reply — `runClaude` now reads the final text + `is_error` from the terminal `result` event and falls back to stderr/raw-stdout only if the session crashed before emitting one. A `result` with `is_error:true` is a failure even on exit 0 (an auth 401 / max-turns case). **Why the runner and not the Slack worker:** the Slack worker that queues the task runs in a 300 s-capped serverless function (`slack-claude-worker/route.ts`, `maxDuration=300`) and is frozen the instant it returns — a `setInterval`/polling tracker there cannot fire. This launchd daemon is the only component alive long enough; its `setTimeout`s genuinely run during the `await runClaude`. There is no `claimed` status for code-runner rows (lifecycle is `pending → processing → done/failed`), so "picked it up" is posted on the single `pending → processing` claim transition. Note: `scripts/mac-mini/code-task-runner.mjs` runs *on the Mac Mini* — a change to it only takes effect after the Mac Mini pulls main and the launchd daemon restarts.

### ask-antonio interactive loop (added 2026-06-12)

A running code-task session can pause and ask Antonio a question in the originating Slack thread, then **block until he replies** before continuing — for the rare decision it genuinely can't make alone (a naming choice, production vs sandbox, an ambiguous requirement).

- **Exposure = a Bash CLI, not an MCP server.** The runner injects a one-line `[ASK ANTONIO]` preamble into the prompt telling the session it may run `node scripts/mac-mini/ask-antonio.mjs "question"`, and spawns the session with per-task env (`CODE_TASK_ID`, `CODE_TASK_QUESTION_CHANNEL`, `CODE_TASK_QUESTION_THREAD_TS`) that the session's Bash-tool children inherit. This avoids a stdio MCP server + `--mcp-config`/launchd wiring entirely; the blocking poll lives in the CLI process the session spawns.
- **The CLI** (`ask-antonio.mjs`) inserts a `pending` `code_task_questions` row, posts the question to the thread ("❓ *Claude needs your input:*"), then polls every 10 s (`ASK_POLL_MS`) until the row leaves `pending`. On `answered` it posts "✅ Got it — continuing." and prints the answer to stdout (the session reads it as the tool result). It self-caps at 30 min (`ASK_MAX_WAIT_MS`, override `ASK_ANTONIO_MAX_WAIT_MS`) — then marks the row `expired` and lets the session proceed without the answer.
- **The webhook answers it.** `app/api/webhooks/slack-claude/route.ts` intercepts (early, before normal mention processing) a thread reply where the sender is Antonio (`U0BAALR4Y4Q`) AND a `pending` row exists for that thread: it UPDATEs the row to `answered` (guarded `.eq('status','pending')`) and returns without running the normal bot pipeline, so Claude doesn't also respond. **Fully defensive** — any error (including the table not existing in an env yet) falls through to normal processing, so it can never break the webhook or swallow a message unless a genuine pending question is present.
- **Timeout pause.** The runner's per-task 30-min SIGKILL would otherwise kill in-progress work if Antonio is slow. While a question is pending, a watcher (`questionWatcher`, polls `code_task_questions` by `task_id` every 8 s) flips `questionPending`, and `runClaude`'s deadline watchdog pushes the kill-deadline forward each tick — so the wait is bounded by the CLI's own 30-min cap, not the task timeout. On settle the runner expires any still-pending question for the task (guarded `.eq('status','pending')`) so a late reply can't be swallowed by a finished task.
- **Concurrency is 1** (the runner processes one code task at a time), so at most one question is pending per thread.
- **Env dependency:** `code_task_questions` must exist in whatever DB the runner + webhook share (production). The webhook's defensive fall-through means deploying the code before the table exists is safe (answer routing is simply a no-op until the table is created).

---

## Calendly read rail (`cal_list_bookings` / `cal_get_event_details` / `cal_get_availability`)

Read-only Calendly access for the Slack worker (2026-06-18). Lets Claude answer
"what meetings are coming up?", "who booked the Tuesday call and why?", and "what's
the booking link for a 30-min call?" directly in Slack.

- **Three read tools**, all read-only (no create/cancel): `cal_list_bookings`
  (upcoming/past bookings — name, time, duration, join link, invitee count, UUID),
  `cal_get_event_details` (one booking by UUID — invitees + booking-form answers),
  `cal_get_availability` (active event types / booking pages + scheduling URLs).
- **Single source of truth:** the logic lives in `lib/mcp/tools/calendly.ts` as
  exported `listCalendlyBookings` / `getCalendlyEvent` / `getCalendlyAvailability`.
  Both the MCP `cal_*` tools AND the worker call these — no duplicated fetch/format.
- **Slack-only (R108):** gated by `CallWorkerOptions.enableCalendly` (set in
  `processSlackEvent`), kept OUT of `WORKER_TOOLS`, plus an executor `availableNames`
  gate — the Hermes/Telegram research worker never receives them.
- **Token:** `CALENDLY_PAT` (production Vercel). No token → each tool returns a clean
  `❌ … failed: CALENDLY_PAT not configured` (no crash).
- Tests: `tests/unit/worker-calendly-reads.test.ts`.

---

## In-channel approval completion (loop fix, 2026-06-18)

The Slack worker can only **propose** writes (`propose_action` queues a `pending`
`approval_queue` row with a fresh 6-digit `confirmation_code`); it has no approve
tool. Before this fix, typing the code back in Slack reached the LLM, which
re-proposed and minted a new code → an infinite loop (precedent: 3 stuck
`lead_create` proposals for "Tobias Toft"; earlier `send_email` proposals expired
unactioned).

- **Part A — link the proposal to its origin.** `proposeAction` stores
  `source_message_id` = the triggering `agent_messages` id, threaded server-side via
  `callWorker → runWorkerLoop → executeWorkerTool` (the model never supplies it). FK
  `approval_queue.source_message_id → agent_messages.id`. No migration. Sets the
  linkage for the Hermes path too.
- **Part B — intercept the code.** `processSlackEvent` diverts a message that is
  **exactly** a 6-digit code (`isSixDigitCode`) **and** from the authorized approver
  (`isAuthorizedApprover`, Antonio / `SLACK_APPROVER_USER_ID`) to
  `handleSlackApprovalCode` **before** the LLM runs. It finds the single `pending`
  proposal in the current env lane whose `source_message_id` belongs to **this Slack
  thread** (matched via `slack_scope_key`, computed from the **raw** `slack_thread_ts`
  so it equals what the webhook stored), atomically approves it (mirrors
  `approval_decide`'s `pending→approved` + code guards), runs it through the existing
  `executeApproval` (honoring `APPROVAL_RAIL_ENABLED`), and edits the ack with the
  outcome. Because the code never reaches the model, no new proposal can be minted →
  the loop is structurally impossible.

**Refusal / safety branches** (all post a clear message, never call the LLM, never
mutate beyond the one matched proposal): non-Antonio sender → not intercepted (normal
worker flow); no message in thread / no pending match → "nothing changed"; two
proposals share the code → refuses to guess; lost approve race → "handled by another
process"; rail disabled → approved-but-not-executed; any error → "did NOT change
anything".

Tests: `tests/unit/slack-approval.test.ts`.

---

## Sandbox constraint

`SANDBOX_MODE=1` blocks `/api/webhooks/*` (middleware.ts:114). The Slack app Event Subscription URL **must** point to production (`https://td-operations.vercel.app/api/webhooks/slack-claude`). The worker cron is **not** blocked and can be tested independently:

```bash
curl -X POST "https://td-operations-sandbox.vercel.app/api/cron/slack-claude-worker?message_id=<UUID>" \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## Slack app setup (one-time)

1. Go to api.slack.com/apps → `A0B9LUJRLMB` (Claude)
2. **Basic Information → Signing Secret** → copy → add as `SLACK_SIGNING_SECRET_CLAUDE` in Vercel
3. **Event Subscriptions** → enable → Request URL: `https://td-operations.vercel.app/api/webhooks/slack-claude`
4. Subscribe to bot events: `app_mention` **and** `message.channels` (the latter is required for thread-reply follow-ups without an @mention)
5. Save and reinstall app if prompted

---

## How to verify current state

```bash
# 1. Check migration was applied
# (sandbox)
psql $SANDBOX_DATABASE_URL -c "SELECT unnest(enum_range(NULL::agent_message_party));"
# Should include 'slack'

# 2. Check cron is registered
grep slack-claude-worker vercel.json

# 3. Check env vars are set (Vercel)
vercel env ls production | grep SLACK

# 4. Simulate a worker run (no real Slack needed)
curl -X POST "https://td-operations-sandbox.vercel.app/api/cron/slack-claude-worker" \
  -H "Authorization: Bearer $CRON_SECRET"
# → { "ok": true, "mode": "scan", "recovered": 0, "processed": 0 }

# 5. End-to-end: mention @Claude in #td-dev → expect "On it 👍" reply within 2s
```

---

## Stop button ("⏹ Stop")

Lets Antonio cancel a message after the "On it 👍" ack but before the worker posts its answer.

- **Ack carries the button.** The webhook posts "On it 👍" with Block Kit (`buildThinkingBlocks`): a section + a danger button (`action_id = stop_thinking`). Plain `text` stays as the notification fallback.
- **Click → `/api/webhooks/slack-interactions`.** Slack sends an `application/x-www-form-urlencoded` body with a single `payload` JSON field. The route verifies the HMAC signature (`SLACK_SIGNING_SECRET_CLAUDE`, same scheme as the events webhook — shared `verifySlackSignature`), parses it (`parseSlackInteraction`), and for `stop_thinking` runs a **conditional** UPDATE: `status='cancelled' WHERE slack_ack_ts = <clicked message ts> AND slack_channel_id = <channel> AND status IN ('pending','processing')`.
- **Correlation key = `slack_ack_ts`.** The clicked message's ts equals the ack ts already stored on the row — no row id needs to ride in the button.
- **Worker honors the stop before posting.** `processSlackEvent` re-reads the live status immediately after `callWorker` returns; if `cancelled`, it skips posting and skips the done-flip. The done-update is also guarded `.eq('status','processing')` (TOCTOU). `claimPending` only claims `status='pending'`, so a Stop that beats the claim prevents the run entirely.
- **What it can't do.** `callWorker` is a single non-interruptible API call — Stop only prevents the answer from being POSTED (or stops a not-yet-claimed run). Claude may keep thinking server-side; the result is just discarded.
- **No-op after the answer lands.** A Stop clicked once `status='done'` matches zero rows → the route leaves the Slack message (the delivered answer) untouched.
- **On stop, the ack morphs** to "⏹ Stopped — go ahead with your update" (`chat.update`, `blocks: []` to drop the button). On normal completion the worker collapses the ack to "✅" (`chat.update`, `blocks: []`) after posting the answer as a separate message.

**Setup (one-time, admin):** Slack app `A0B9LUJRLMB` → **Interactivity & Shortcuts** → enable → Request URL `https://td-operations.vercel.app/api/webhooks/slack-interactions`. Production-only (`SANDBOX_MODE=1` blocks `/api/webhooks/*`).

---

## Animated "thinking" indicator

While the worker runs `callWorker` (one non-interruptible API call, ~8–15 s), the "On it 👍" ack visibly animates so Antonio sees Claude is actively working.

- **Where:** `processSlackEvent` in `slack-claude.ts` starts a `setInterval` (`THINKING_TICK_MS = 3000`) right before the `callWorker` try-block and clears it in a `finally`, so the timer stops on success, image-retry, or rethrow alike. Node's event loop runs the timer during the `await` (Vercel Fluid Compute is plain Node).
- **What it shows:** `thinkingIndicatorText(tick)` (pure, unit-tested) cycles ascending-dot frames "🔍 Looking into it." → ".." → "..." and wraps. Each tick `chat.update`s the **same ack message** (`slack_ack_ts`) with `buildThinkingBlocks(frame)` so the "⏹ Stop" button is re-attached and stays clickable.
- **Only when there's an ack:** skipped entirely if `slack_ack_ts` is null (the ack post failed).
- **Stop-safe:** each tick re-reads the live row status and **stops the moment status ≠ `processing`** (Stop click → `cancelled`). This prevents a stray tick from clobbering the interactions webhook's "⏹ Stopped — go ahead with your update" notice or re-adding the Stop button. An in-flight flag also skips a tick while the previous `chat.update` is still pending.
- **Residual race (cosmetic only):** a sub-millisecond TOCTOU window exists — a tick can read `processing`, the Stop webhook then cancels + morphs, and the tick's already-issued `chat.update` lands after. Outcome: the ack briefly shows a "Looking into it" frame instead of "Stopped"; the worker still skips posting the answer (the post-`callWorker` cancellation re-read at `processEvent` returns early). Not worth a lock given best-effort cleanup.
- **Rate limit:** 1 `chat.update` / 3 s = 20/min, well under Slack's Tier 3 (~50/min).

## Related subsystems

- [`agent-bridge.md`](agent-bridge.md) — Hermes ↔ Claude bridge (same `agent_messages` table, same `callWorker` pattern)
- [`hooks-guardrails.md`](hooks-guardrails.md) — Sandbox enforcement (SANDBOX_MODE blocks `/api/webhooks/*`)

---
_2026-06-21 — Client Threads (Phase 1, dev_task 54f89912): added the Slack-only `tag_client_thread` (write) + `find_client_threads` (read) tools in `lib/ai-agent/worker-tools.ts` (gated via `enableClientThreadTag`/`enableClientThreadRead`, kept OUT of `WORKER_TOOLS`, R108) and wired the `#td-support` auto-tag in `lib/ai-agent/slack-claude.ts::processSlackEvent`. Full subsystem doc: [client-threads.md](client-threads.md)._

---
_2026-06-21 (Phase 2) — Client-conversation form: a pinned button in #td-support opens a Block Kit modal (client external_select + topic) that starts a labeled, tagged thread; the worker is grounded with the client/topic and each exchange is logged to the CRM. New helpers + interactivity-route handlers in slack-claude.ts / slack-interactions route. See [client-threads.md](client-threads.md)._

_2026-06-21 (Phase 2.1) — modal now supports "Or type a new topic": optional free-text field; `ensureTopicSlugFromText` slugifies it and adds it to the topic_templates catalog (reusable next time). Script `post-client-conversation-button.mjs` hardened with an auth.test guard (refuses any non-Claude bot token)._

_2026-06-21 (Phase 2.2) — added a GLOBAL SHORTCUT entry point ("new_client_conversation") so the form opens from the ⚡ shortcuts menu (always available, never scrolls away) instead of relying on an in-channel button. Global shortcut has no channel → defaults the new thread to SLACK_SUPPORT_CHANNEL_ID. Route handles type="shortcut"; openConversationModal shared by button + shortcut._

_2026-06-21 (Phase 1b) — per-entity COLLAPSIBLE Conversations panel on contact/account/lead pages (no rollup: a thread shows only under the entity it was tagged to). Reads client_threads for that entity; each row = topic · date · Slack link; expand pulls the thread messages LIVE from Slack (fetchSlackThreadMessages → conversations.replies). New: /api/client-threads (list) + /api/client-threads/[id]/messages (expand), components/conversations/client-conversations-panel.tsx._

_2026-06-21 (Phase 1b polish) — cleanSlackText() renders thread messages readable in the CRM panel (resolves <@user> mentions to names, strips :emoji: shortcodes + *bold*/_italic_/`code`, unwraps <url|label>). Backfilled crm_log rows now expand to their stored conversations content (client_message/response_sent) instead of "no thread"._

_2026-06-22 (Phase 2.3) — CLOSE a conversation (frozen transcript). New client_threads cols transcript/closed_at/closed_by (migration 20260622-0900). closeClientThread snapshots the full thread into transcript + status=closed; reopenClientThread reverts to live. Close from CRM (Close/Reopen button in the panel → /api/client-threads/[id]/close) OR from Slack (✅ reaction on the conversation's starting message). Closed → messages endpoint serves the frozen snapshot (permanent, survives Slack deletion)._

_2026-06-22 (Phase 2.4) — propose-continue dedup: the form, on submit, checks for an existing OPEN conversation for the same client+topic (findOpenConversationForEntityTopic). If found, it updates the modal (buildDuplicateConfirmView) showing "already open, opened <date>" + a link to continue there, or "Start new anyway" (carries the selection in private_metadata confirm:true → second submit skips the check and creates). Prevents form+@Claude duplicates; one open conversation per client+topic._

_2026-06-22 (Phase 2.5) — /client SLASH COMMAND: new app/api/webhooks/slack-commands route opens the same client-conversation modal by typing /client (reliable entry point since the global shortcut is hard to find). Shared openClientConversationModal helper now used by all three entry points (button, shortcut, slash command); interactions route refactored to it._

_2026-06-22 (Phase 3 Part 1+3) — per-client brain. decision_memory gets a client_key + a sibling recall fn match_decision_memory_client (original untouched). saveDecisionMemory accepts clientKey; recallClientDecisionMemory + buildClientRecallSuffix inject "WHAT WE KNOW ABOUT <client>" before the worker answers in a tagged client thread (callWorker opts.clientKey/clientName, set by processSlackEvent). FEED (human-confirmed only, no poisoning): closing a conversation saves its transcript as a client-scoped memory (closeClientThread). Migration 20260622-1100._

_2026-06-22 (Phase 2.6) — /client conversation threads are now dedicated worker threads: a plain reply (no @Claude) in an OPEN client_threads thread is processed by the worker (route.ts isOpenClientConversationThread relaxes Case 3 of the invitation gate; Case 2 explicit @other still skips; closed threads not auto-answered). Labeled message updated to "Just reply here — I am listening". Fixes having to @Claude every message + drifting to separate untagged threads._
