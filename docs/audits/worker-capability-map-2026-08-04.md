# AI Worker — Capability Map (deep audit)

**Date:** 2026-08-04 · **Type:** point-in-time audit report, NOT a system doc (system docs live in `docs/systems/`)
**Repo state:** worktree `nice-stonebraker-41761f` at `38e1d536`, clean, zero diff vs `origin/main`
**Status:** v3. v1 contained three blocker-level errors; a five-reviewer council found them and v2 fixed them (record in §11). v3 then corrects v2 itself: Antonio ruled that the absent portal Confirm card on the client-chat panel is a deliberate design, not the safety gap the council and I both took it for — see §1 note ⁴.
**Method:** read-only. Every claim is cited to `file:line` in this working tree or to a live production query run during this audit. Where a doc or a source comment contradicts the code, the code is recorded and the contradiction is listed in §9. Anything not verifiable in source is written **not verified**.

**Citation convention:** a bare `:NNN` refers to the file named at the start of that row or paragraph. Where a table mixes files, each cell names its file.

---

## 0. What the worker is, in one paragraph

One engine — `callWorker` (`lib/ai-agent/worker-tools.ts:4571`) wrapping a raw Anthropic Messages-API tool-use loop (`runWorkerLoop`, `:4017`) — is mounted on six call paths. It is not a persistent agent: each turn is a fresh HTTP request that rebuilds its own context, runs up to N tool iterations, and returns text. Everything that looks like memory is reconstructed per turn from the database.

**Invocation paths (complete):**

| # | Path | Entry point | Engine call |
|---|---|---|---|
| 1 | CRM Inbox panel | `app/api/inbox/worker-chat/route.ts:105` | `:735` |
| 2 | Portal Chats panel (staff-side) | same route, `clientKey` mode `:119` | `:735` |
| 3 | CRM dashboard sidebar | `app/api/ai-agent/route.ts:46` → `runSidebarWorker:192` | `:440` |
| 4 | Team Chat `@claude` | `lib/team/claude-trigger.ts`, cron `app/api/team/claude/process/route.ts` | `:466` |
| 5 | Portal-chat reply suggester | `app/api/portal/chat/suggest/route.ts:32` | `:223` |
| 6 | Hermes bridge cron | `app/api/cron/hermes-bridge/route.ts` | `:142` |
| 7 | **Cross-border advisory lenses** — TWO further full worker calls, fanned out concurrently, invoked *by* path 5 | `lib/ai-agent/cross-border-check.ts:89` | `:99-105` (`Promise.allSettled`), run in parallel with the main draft at `suggest/route.ts:223-233` |
| 8 | **Size-recovery retries** — `callWorkerWithAttachments` re-invokes `callWorker` up to 3× on an over-large request (full → media-slimmed → text-only) | `lib/ai-agent/attachment-reader.ts:545` | `:552`, `:577`, `:590` |
| — | Behaviour test script (not a surface) | `scripts/test-safe-fixes-behaviour.ts:43` | — |

A single gated suggester turn therefore issues **three** independent worker runs, not one.

**Live traffic, production `agent_messages`, last 30 days (queried 2026-08-04):**

| surface label | sender→recipient | msgs | last seen |
|---|---|---|---|
| `portal-chats` | crm→worker | 481 | 2026-08-04 18:30 |
| `inbox` | crm→worker | 183 | 2026-08-04 14:39 |
| `dashboard` | crm→worker | 80 | 2026-08-04 19:37 |
| `team-chat` | crm→worker | 71 | 2026-08-04 17:17 |
| (null) | slack→claude | 136 | **2026-07-27** — stopped |
| (null) | worker→hermes | 3 | **2026-07-11** — stopped |

The suggester and its lenses write no `agent_messages` row (no `threadId`), so they do not appear.

**Capability is not usage.** Production `worker_prepared_sends`, all time (queried 2026-08-04): email 14 sent / 3 pending; portal 3 sent / 6 cancelled / 1 pending — first email freeze 2026-07-29, first portal freeze 2026-08-03. Against 815 worker turns in 30 days that is **17 confirmed outbound messages ever**, all from the Inbox and Portal Chats panels. Sections 1 and 8 weight send rails heavily because the *code* does; the *use* today is overwhelmingly read-and-draft.

---

## 1. Surface × capability matrix

Legend: **✅** wired on · **—** not wired · **⚙** conditional on an env/DB fact · **🔒** exists but hard-refused at the executor.

| Capability | Inbox | Portal Chats | Sidebar | Team Chat | Suggester | Hermes |
|---|---|---|---|---|---|---|
| Base read tools — 33, **but see note ¹** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Thread memory (`threadId`) | ✅ `worker-chat:736` | ✅ | ✅ `ai-agent:441` | ✅ `claude-trigger:467` | — | ✅ `hermes-bridge:143` |
| Conversation replay | ✅ `worker-chat:802` | ✅ | ✅ `ai-agent:536` | — (deliberate; own recap `claude-trigger:365-375`) | — | — |
| Raw read-only SQL (`enableDbRead`) | ✅ `:785` | ✅ | ✅ `ai-agent:457` | ✅ `claude-trigger:482` | — | — |
| Sysdoc/SOP/Drive/portal-attachment reads | ✅ `:786` | ✅ | ✅ `:458` | ✅ `:483` | ✅ `suggest:226` | — |
| Circleback call reads | ✅ `:787` | ✅ | ✅ `:459` | ✅ `:484` | — | — |
| Calendly reads | ✅ `:788` | ✅ | ✅ `:460` | ✅ `:485` | — | — |
| Client-thread lookup (read) | ✅ `:789` | ✅ | ✅ `:461` | ✅ `:486` | — | — |
| Client-thread **tagging** (write) | — | — | — | — | — | — (set only in dead `slack-claude.ts:1915,2092`; and see §8b.7 — it fails even if flagged) |
| Cross-thread semantic recall | ⚙ ² `:790` | ⚙ ² | ⚙ ² `:462` | ⚙ ² `:488` | — | — |
| Web search / fetch | ⚙ ³ `:791` | ⚙ ³ | ⚙ ³ `:463` | ⚙ ³ `:487` | ⚙ ³ **via its lenses** `cross-border-check.ts:101` | — |
| CRM note writes (6 tools) | ✅ `:792` | ✅ | ✅ `:464` | **—** (gap, §8b.1) | — | — |
| Full catalog reach (`find_tool`/`use_tool`) | ⚙ `:797` | ⚙ | ⚙ `:467` | ⚙ `:489` | — | — |
| Email send | ✅ `:617` | ✅ `:672` | ⚙ client page only `sidebar-send-rails.ts:128` | **✅ every thread** `claude-trigger:273-278, 333-353` | — | — |
| **Attach a stored client document to that email** | ✅ `worker-tools:3034` | ✅ | ✅ | ✅ | — | — |
| Portal-chat send | ✅ **freeze-only** `:652-660` | ✅ **direct**, pinned `:663` | ⚙ direct, pinned `sidebar-send-rails.ts:118` | ⚙ direct, pinned `claude-trigger:244-249` | — | — |
| Team-chat send | — | — | — | ✅ `claude-trigger:508` | — | — |
| Code-task rail | — | — | — | 🔒 explicit `false` `:512` | — | — |
| Attachments **in** (images / PDF blocks) | ✅ `:763` | ✅ | ✅ `ai-agent:470` | ✅ `claude-trigger:479` | ✅ images only `suggest:230` | — |
| Re-readable uploads (`pinnedUploads`) | ✅ `:780` | ✅ | ✅ `:477` | — (§8b.6) | — | — |
| Email-attachment pin | ✅ `:767` | — | — | — | — | — |
| Artifacts **out** (PDF/spreadsheet) | ⚙ produced, **discarded by the route** (§8b.8) | ⚙ same | ⚙ rendered `ai-agent:599` | ⚙ produced, not rendered | — | — |
| Client-scope boundary | — | ✅ `:697` (but see §5) | — (built, not passed — §8b.2) | — | — | — |
| **Confirm card — email** | ✅ | ✅ | ✅ `ai-agent:583` | ✅ `claude-trigger:564-589` | — | — |
| **Confirm card — portal** | ✅ `:653` | **— none, by design** ⁴ | — | — | — | — |
| Max tool iterations | 20 `:798` | 20 | 20 `ai-agent:468` | 20 `claude-trigger:475` | 6 `suggest:229` (lenses: 4) | `context_json.max_iterations`, clamped [1,50] `hermes-bridge:65-70` |
| Dedicated API key | — | — | — | ✅ `WORKER_KEY_TEAM_CHAT` `claude-trigger:474` | — | — |

**¹ The base 33 is a default, not a floor.** Whenever `threadId` is set — which is every surface except the suggester — `callWorker` **replaces** the tool list with `getToolsForThreadType(threadType)` (`worker-tools.ts:4589`). The stored `thread_summaries.thread_type` decides: `investigation` (the default, `thread-routing.ts:40`) and `action_request` resolve to all 33; `bug_report` = 22, `client_audit` = 20, `internal_ops` = 5 (`thread-routing.ts:114-129`). No live surface writes a non-default type today, so the ✅ holds in practice. **Note the ordering:** every conditional injection happens *after* the narrowing (`:4640-4758`), so thread-type routing constrains the read set only — it is not a security boundary over sends, SQL or the catalog bridge, despite `thread-routing.ts:9-11` describing it as defense-in-depth.

**² Cross-thread semantic recall is dark by default.** `semanticRecallEnabled()` returns `process.env.THREAD_RECALL_SEMANTIC_ENABLED === "true"`, documented as OFF so the code could ship before its migration (`thread-recall.ts:32-44`). Both consumers early-return on it (`:82`, `:114`), so `buildRelatedThreadsSuffix` yields `""` and `embedThreadSummary` writes nothing unless it is set. **Not verified** whether it is set in production.

**³ Web tools need `WORKER_WEB_SEARCH_ENABLED === "true"` on top of the per-call flag** (`worker-tools.ts:4804`). **Not verified** in production.

**⁴ Portal Chats has no portal Confirm card, and is not supposed to have one.** Antonio, 2026-08-04, on reading v1 of this audit: *"we don't need the card in the portal chats — unless the worker has to send an email from the portal chats. When we use the worker in the portal chats regarding the client we are in, we don't need any cards. We talk to the worker, decide the message to send, the worker drafts the message and we say 'send it', that's it."*

The code matches that decision exactly. `portalSendPrep` is set only on the Inbox branch (`worker-chat/route.ts:653`); the Portal Chats branch (`:662-706`) sets `pinnedPortalRecipient` and no prep, so `send_portal_message` takes the direct path (`worker-tools.ts:2743-2807`). Corroborated live: all 10 `kind='portal'` rows in `worker_prepared_sends` carry `mailbox IS NULL` and no Gmail thread — all originated on the Inbox freeze path.

**Why a card is unnecessary here and necessary on the Inbox** — the distinction the design turns on: the panel is already open on ONE client, so the server knows the recipient as a fact and pins it (`worker-tools.ts:2745-2748`); the staff member is looking at that client's conversation while approving; and the draft is shown in the chat before "send it". The Inbox has none of that — it is an email thread that may be written by a stranger and names no client, so the recipient has to be *chosen* by a human, which is what the card is for. The controls that still apply on Portal Chats are the client pin and the language guard (`:2761-2784`).

**Email from Portal Chats is a different matter and DOES get the card** (`worker-chat:687`) — a new address there freezes for one confirmation, because the recipient is not a server-known fact.

**Auth gates:**

| Surface | Gate |
|---|---|
| Inbox / Portal Chats | session + `isDashboardUser` `worker-chat/route.ts:108`; mailbox access re-checked on POST at `:211` (the GET history handler checks at `:54`) |
| Sidebar | session; clients rejected `ai-agent/route.ts:59`; non-admins need `app_settings.ai_agent.enabled_for_team` `:63-73`; rate limit 20/min `:48` |
| Team Chat | `CRON_SECRET` bearer, server-to-server only `team/claude/process/route.ts:18-22` |
| Suggester | session + `isDashboardUser` `suggest/route.ts:41`; rate limit 6/min `:34` |
| Hermes bridge | `CRON_SECRET` bearer |
| Model change | admin only `app/api/ai-agent/model/route.ts:44` |
| **Confirm an email draft** | any dashboard user + mailbox access — **no actor check** (`confirm-send/route.ts:73-101`). The portal branch *does* check (`:62` passes `rowActor`, verified `worker-portal-freeze.ts:139-146`). So a colleague's frozen email draft can be confirmed by anyone; a frozen portal message cannot. |

---

## 2. Full tool catalog, with per-surface availability

### 2a. The base — `WORKER_TOOLS` (33)

`WORKER_TOOLS` = `AGENT_TOOLS` filtered by `WORKER_READ_ONLY_TOOL_NAMES` (30 names, `worker-tools.ts:95-146`) **+** `codebase_read` `:199` **+** `codebase_search` `:211` **+** `memory_save` `:2048`. Assembly `:2084-2089`. All 30 resolve against `AGENT_TOOLS` (52 entries, `tools.ts:45-727`) — recounted by hand.

The 30 reads: `search_accounts`, `get_account_detail`, `get_client_360`, `search_contacts`, `search_services`, `search_payments`, `search_tasks`, `search_leads`, `search_deals`, `search_tax_returns`, `search_deadlines`, `search_portal_messages`, `search_conversations`, `get_client_paperwork`, `search_documents`, `get_client_history`, `read_scanned_document`, `portal_chat_inbox`, `portal_chat_read`, `get_dashboard_stats`, `search_kb`, `get_sop`, `search_templates`, `gmail_search`, `gmail_read`, `gmail_read_thread`, `drive_search`, `drive_list_folder`, `memory_recall`, `recall_memories`.

**15 of the 52 `AGENT_TOOLS` are offered to no worker surface by any route:** `advance_service_stage`, `create_task`, `drive_move`, `drive_upload_file`, `gmail_get_attachments`, `log_conversation`, `preview_attachment`, `run_sql_query`, `save_memory`, `send_email`, `send_team_message`, `update_contact`, `update_deadline`, `update_service`, `update_task`. (`run_sql_query` and `send_email` appear only as separate hardened `ToolDef`s; the six `update_*_notes` are re-added through `CRM_NOTE_TOOLS`, `:2064-2071`; `memory_save` is re-added at `:2048`.)

### 2b. Conditionally injected tools (`callWorker`, `:4637-4758`)

| Tool | Gate | Injected | Executor `availableNames` re-check |
|---|---|---|---|
| `start_code_task` | `enableCodeTasks` | `:4640` | **no** — but refuses on the rail switch `:2448` |
| `promote_code_branch` | `enableCodeTasks` | `:4644` | **no** — refuses on the rail switch `:2464` |
| `send_portal_message` | `enableSlackSend` | `:4652` | **NO — fails open** (§5) |
| `team_chat_send` | `enableTeamChatSend` | `:4658` | yes `:2813` |
| `run_sql_query` (hardened) | `enableDbRead` | `:4665` | **NO — fails open** `:2885-2887` |
| `recall_thread` | `enableThreadRecall` + `threadId` | `:4672` | yes `:2957` |
| `send_email` | `enableEmailSend` | `:4679` | yes `:2500` |
| `list_calls` / `get_call` / `search_calls` | `enableCallReads` | `:4687` | yes `:2892` |
| 6 × `update_*_notes` | `enableCrmNotes` | `:4697` | yes `:2904` |
| `read_email_attachment` | **presence of `pinnedEmailAttachments`** | `:4707` | yes `:2937` |
| `read_uploaded_file` | **presence of `pinnedUploads`** | `:4715` | yes `:2946` |
| 3 × Calendly | `enableCalendly` | `:4723` | yes `:2913` |
| `search_sysdocs`/`read_sysdoc`/`search_sops`/`read_drive_file`/`read_portal_attachment` | `enableDocReads` | `:4733` | yes `:2924` |
| `find_tool` / `use_tool` | `enableFullToolReach` | `:4743` | yes `:2978`, `:2991` |
| `tag_client_thread` | `enableClientThreadTag` | `:4753` | yes `:2840` |
| `find_client_threads` | `enableClientThreadRead` | `:4756` | yes `:2846` |
| `web_search` / `web_fetch` (Anthropic server-side) | `enableWebSearch` **AND** `WORKER_WEB_SEARCH_ENABLED` | `:4803-4806`, built `:3889` | n/a |

Two tools use **pin-as-gate**: `read_email_attachment` and `read_uploaded_file` exist only because the server supplied an allow-list (`:4703-4717`). Verified un-spoofable — both resolve by exact `.ref` match against the server array and use the array's own locator, never the model's (`:1029`, `:1088`, re-validated at `attachment-reader.ts:643`).

`propose_action` (`:156`) is still defined and exported but **removed from `WORKER_TOOLS`** (`:2078-2083`) — no surface offers it.

**Four live `CallWorkerOptions` fields do not appear as matrix rows** because they modify a rail rather than grant one: `emailConfirmExempt`, `forceMailbox`, `sendActor`, `onBehalfOf`. See §5.

### 2c. The catalog reach (`find_tool` / `use_tool`)

`find_tool` searches a registry built from **47 hardcoded registerer imports** in `mcp-bridge.ts:81-92` — **not** derived from the live MCP server list in `app/api/[transport]/route.ts`, so drift between the two is invisible. Ranked word-overlap scoring (`tool-search.ts:126`).

`use_tool` runs the named tool **through the risk policy** (`tool-risk.ts:318`):
- `HARD_BLOCKED_TOOLS` — 12, refused outright (`:55-72`).
- `READ_TOOLS` — 59, positive allow-list, auto-run (`:173-226`).
- Everything else → `proposeAction`, which **refuses while the action rail is off** (`worker-tools.ts:3013-3018` → `:2175`).

Execution path detail: `runToolByName` (`mcp-bridge.ts:186-189`) sends any name that exists in `AGENT_TOOL_NAMES` to `executeTool` — the agent executor — rather than the MCP bridge, and falls back to `executeTool` for unknown names. No extra capability, but the path is not purely "the MCP bridge".

Net today: a **59-tool read expansion with a 12-tool hard block**, every write/external path dead-ending in the off rail.

---

## 3. Model routing

- **Worker catalog:** 6 curated options (`worker-models.ts:43-74`) — `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.
- **Precedence** (`resolveWorkerModelAsync:3989`): per-call `model` → stored `app_settings.worker_model` (validated by `isAllowedWorkerModel`, `:4004` / `worker-models.ts:77`) → `process.env.WORKER_MODEL` (**unvalidated**, `:3963`) → `WORKER_MODEL_DEFAULT = "claude-sonnet-4-6"` (`:3959`). Cached 30 s (`:3981`).
- **Live production value (queried 2026-08-04):** `app_settings.worker_model = "claude-fable-5"`, set 2026-07-28 17:07. It is in the curated list, so it is honoured — every worker path, including the suggester, its two lenses and the Hermes cron, runs on Fable 5.
- **UI:** ⚙ gear (`components/chat/worker-settings-gear.tsx:30`) on Portal Chats (`thread-worker-panel.tsx:252`), Inbox (`worker-chat-panel.tsx:450`), sidebar (`ai-agent-panel.tsx:544`). Read by any staff member, **written only by an admin** (`model/route.ts:44`).
- **No caller sets a per-call `model`** — the option is fully plumbed (`:3484` → `:4817` → `:4051`) and unused.
- **Request shape** (`:4146-4160`): `max_tokens: 16384`; system block carries `cache_control: ephemeral`.
  **Caveat the source comment misses:** that single cached block also carries the per-turn memory suffixes appended at `:4775` (auto-recall, embedded from *this* turn's text), `:4789` (client brain) and `:4798` (related threads). The prefix therefore changes every turn, so the within-loop cache hit is real but the cross-turn hit the comment claims at `:4153` cannot occur on any surface with memory.
- **Key:** `resolveWorkerApiKey:3944` — per-call override → `ANTHROPIC_API_KEY`. Overrides come from `surfaceApiKeyOverride` (`surface-api-key.ts:35`), convention `WORKER_KEY_<SURFACE>`; legacy `SLACK_WORKER_ANTHROPIC_KEY` honoured only for surface `slack` (`:42`). Only Team Chat uses it (`claude-trigger:474`).

**Three other models run inside the worker's own lifecycle — the gear does not govern them:**

| Engine | Model source | Reached from |
|---|---|---|
| Business-Brain lesson extractor | `callAI` with its own model map (`lib/portal/ai-provider.ts:46`, fallback `:132-139`) | `lesson-capture.ts:30`, run after the reply on Inbox / Portal Chats / Team Chat |
| Legacy sidebar engine | Anthropic **or** `gpt-4o` (`providers.ts:339`), with a provider fallback chain (`:400-417`) and a client-supplied `provider` accepted at `ai-agent/route.ts:167` | only when `WORKER_SIDEBAR_LEGACY=true` |
| Embeddings | OpenAI `text-embedding-3-small`, 1536 dims (`decision-memory.ts:17-18`) | auto-recall, client brain, thread recall |

---

## 4. Context and memory systems

### Rebuilt every turn
- **System prompt.** Base `SLACK_WORKER_SYSTEM_PROMPT` (`slack-claude.ts:94`) on every CRM surface, plus a per-surface addendum generated from the rails actually assigned (`buildWorkerSurfacePrompt`, `inbox-worker-prompt.ts:48+`). Hermes uses `WORKER_SYSTEM_PROMPT` (`worker-tools.ts:3201`); the suggester supplies its own (`suggest:190-193`); each lens supplies its own (`cross-border-check.ts:100`).
  **Failure mode worth knowing:** if thread setup throws, the catch at `:4627-4634` resets `systemPrompt = WORKER_SYSTEM_PROMPT`, **discarding the caller's override** — so a `thread_summaries` hiccup drops the generated capability statement, the client card and the template block while every send rail and pin stays armed. Logged as a `console.warn` only.
- **Thread context.** `buildThreadContext` (`thread-context.ts`) → "EARLIER IN THIS CONVERSATION" (`:4623`).
- **Conversation replay.** `buildReplayTurns` re-sends recent complete pairs as **real messages** (`:4607`, `:4116-4122`). Inbox, Portal Chats, sidebar only.
- **Auto-recall.** `buildAutoRecallSuffix` (`:4531`) injects top-3 lessons above cosine 0.45 (`:4500`) on **every** call, and bumps each recalled row's stats (`trackRecall` defaults true, `decision-memory.ts:229-233`).
- **Per-client brain.** `buildClientRecallSuffix` (`:4553`) when `clientKey` is set (`:4788`). **The suggester passes no `clientKey`** (`suggest:223-231`) — so on the one surface that is entirely about a single client, neither client recall nor lesson capture fires.
- **Cross-thread recall.** `buildRelatedThreadsSuffix` (`thread-recall.ts:160`) — gated by `enableThreadRecall` **and** the dark-by-default `THREAD_RECALL_SEMANTIC_ENABLED` (`:42`).
- **Approved-copy grounding.** `loadRelevantTemplates` + `formatTemplatesForPrompt` (`templates.ts`) on Inbox/Portal Chats (`worker-chat:727`), Team Chat (`claude-trigger:461`), suggester (`suggest:181`).
- **Verified client card.** `buildClientCardSuffix` (`client-card.ts`) on Portal Chats (`worker-chat:396`) and the sidebar (`ai-agent:431`) — per-call suffix, never persisted, values sanitized (`client-card.ts:26`).

### Persisted

| Table | What it holds | Live rows (2026-08-04) |
|---|---|---|
| `agent_messages` | one row per turn; `thread_id` deterministic from a scope string (`inbox-worker-prompt.ts:26`); per-thread partial unique index → 409 on a concurrent turn (`worker-chat:576-581`); Team Chat writes after the reply (`claude-trigger:627`) | see §0 |
| `thread_summaries` | durable summary + outcome (`resolveThread`, `:4853`); extractive, 600 chars (`:3866`); re-embedded only under `enableThreadRecall` (`:4858`) | — |
| `decision_memory` | the Business Brain; embeddings 1536-d | — |
| `agent_memory` | **the second store** — key/value session notes, read by `recall_memories` (in the base 33, `:145` → `tools.ts:2526`). Its writer `save_memory` is on the never-offered list and its prompt-injector `loadGlobalMemories` (`tools.ts:2594-2607`) lives only in the **legacy** engine. Net: the live worker reads a store nothing writes any more | 3 |
| `worker_prepared_sends` | every frozen email/portal draft — the table the whole Confirm-card design writes to | 27 |
| `worker_send_markers` | send dedup | 59 |
| `client_threads` / `client_thread_follows` | what `find_client_threads` reads | 801 / 5 |

### The Business Brain forgets by default
`app/api/cron/memory-decay/route.ts:23-26, 59-79` (monthly, `0 9 1 * *`) decays confidence by 0.05/month for any `decision_memory` row not recalled in 60 days and flips it to `deprecated` at ≤0.2; recall filters `status='active'`, so the lesson silently stops surfacing. `memory-digest` (weekly, `0 9 * * 0`) posts its only output **to Slack** (`route.ts:77-87`, `SLACK_BOT_TOKEN_CLAUDE`) — the surface §7 records as removed. Two further destructive paths exist and are never invoked by a worker turn: `contradictMemory` (`decision-memory.ts:325`) and `voidMemory` (`:388`). Supersession threshold `SUPERSEDE_THRESHOLD = 0.93` (`lesson-capture.ts:45`).

### Lesson capture
`captureLessonFromTurn` (`lesson-capture.ts:272`) after the reply on Inbox/Portal Chats (`worker-chat:851`) and Team Chat (`claude-trigger:662`). Client in context → client-scoped raw; no client → **global but scrubbed**, failing closed (`:173`). Inputs are only the raw staff message + prior worker reply (`:22-28`). Hermes also writes memory: `detectAndSaveCorrection` runs post-reply (`hermes-bridge:41, 184`) — so the "read-only" Hermes path does have one write.

🧠 reaction saves: `chat-memory-reaction.ts:110`, `:54` — wired from Team Chat (`team/messages/[id]/react:47`), portal reactions (`portal/chat/message/[id]/react:150`) and the Inbox remember endpoint (`worker-chat/remember:5`). Staff-gating is the route's job (`chat-memory-reaction.ts:6-10`).

### Budgets and limits
| Limit | Value | Source |
|---|---|---|
| Default tool loops | `AGENT_MAX_TOOL_LOOPS` or 8 | `:3288` |
| Per-surface loops | 20 CRM · 6 suggester · 4 lenses · clamped [1,50] Hermes | §1 |
| Per-API-call timeout | 240 s, shrinking with remaining budget | `:3289`, `:3305` |
| Whole-loop wall clock | 250 s | `:3296` |
| Route `maxDuration` | 300 s everywhere | e.g. `worker-chat:35` |
| Transient retry | bounded by attempts **and** remaining wall clock | `:4138-4168` |
| Exhaustion | one final **no-tools** synthesis call | `:4398-4460` |
| Attachments/turn · bytes · image · PDF blocks | 5 · 20 MB · 5 MB · 2 | `attachment-reader.ts:32,34,36,38` |
| Media base64 budget | 16 MB | `:372` |
| **Per-turn text budget** | 3 × per-file cap | `:390` |
| Per-file read window | `WORKER_FILE_READ_CAP` / `_DASHBOARD` | `slack-file-reader.ts:38`, `attachment-reader.ts:404` |
| SQL result · call transcript · doc · OCR caps | 8 000 · 120 000 · 40 000 · 50 000 chars | `worker-tools.ts:251, 540, 838, 1252` |
| Web searches/turn | `WORKER_WEB_SEARCH_MAX_USES` or 5 | `:3880` |

**Files out.** Only via the catalog bridge (`pdf_create` / `spreadsheet_create`), captured server-side by `extractArtifact` (`:3835`) from the tool's own `Download:` line. **`runWorkerLoop` returns `artifacts` on ONE of its four exits** (`:4317-4324`); the exhaustion-synthesis exit (`:4449`), the empty-reply exit (`:4330`) and the limit-message exit (`:4465`) all drop them. A file produced late in a long turn is therefore discarded on every surface — and because the phantom-file latch reads `artifacts.length` (`:4248`), the model may then be told to make it again.

---

## 5. Guard and control inventory, by enforcement layer

### Enforced in code, at the executor

| Control | What it does | Where |
|---|---|---|
| Client-scope boundary | Refuses a call naming a different client on a pinned surface; resolves `use_tool` nesting first | `:2438-2443`, policy `client-scope.ts:71` |
| Read-only SQL assertion | Single statement, `SELECT`/`WITH` only, write-keyword blocklist, `auth.*` + token/password tables blocked | `:235-322` |
| `availableNames` re-check | Present on **11 of the 17** injected tools (`:2500, 2813, 2840, 2846, 2892, 2904, 2913, 2924, 2937, 2946, 2957, 2978, 2991`). **Absent — and failing open — on `run_sql_query` (`:2885`) and `send_portal_message` (`:2684`).** The three rail tools instead fail closed on the switch. See the gap note below. |
| **Every email is frozen** | `send_email` with no `emailSendPrep` refuses outright | `:2534-2540` |
| One frozen email per turn | second freeze refused | `:2602-2607` |
| One parseable recipient on freeze | blocks CRLF/quoted-local-part smuggling and silent recipient-dropping; multi-recipient and unparseable `to` both terminate in a refusal `:2663-2673` | `:2585-2597` |
| Mailbox override (server) | `forceMailbox` overwrites the model's `from` | `:2509-2511` |
| **Mailbox re-choice (human)** | At Confirm the staff member may pick support@ or antonio@, overriding `forceMailbox` — gated by `checkMailboxAccess` on the *chosen* mailbox | `confirm-send/route.ts:29-33, 78-81, 101` |
| Portal freeze-before-send | presence of `portalSendPrep` makes the tool freeze, checked first in the branch | `:2716-2741` |
| Portal fail-closed | send context with neither pin nor card → refuse — **conditioned on a send context existing** | `:2803-2805` |
| Portal language guard + latch | refuses a confidently-English draft to an Italian-language client, latches sends off for the turn — **also conditioned on a send context** | `:2761-2784`; `draft-language.ts:61` |
| Portal recipient pin | executor overwrites model-supplied ids | `:2745-2748` |
| Action-rail choke point | `proposeAction` refuses while the rail is off | `:2175-2177` |
| Code-rail choke point | both code tools refuse while the rail is off | `:2448`, `:2464` |
| Risk classifier | positive allow-list; 12 hard-blocked; everything else → approval | `tool-risk.ts:55, 173, 318` |
| Untrusted-result fencing | every **client** tool result that may carry third-party text is wrapped as DATA | `:3922`, prefixes `:3904` |
| SSRF allow-list | attachment downloads restricted to trusted storage hosts | `attachment-reader.ts:46-49`; a second list at `worker-tools.ts:1121` |
| Upload-path validation | a model-supplied storage path never reaches the service-key client | `attachment-reader.ts:633` |
| Attach-ref minting | a document becomes attachable only after the **server** returned it this turn | `:3034`, `offerSearchedDocuments:3047` |
| Confirm endpoint | a human click dispatches; atomic pending→sent claim + TTL in `worker-email-send.ts:39, 349, 359`; 409 on re-confirm at `confirm-send/route.ts:44-48` |

**Gap the executor gates do not close.** `send_portal_message` has no `availableNames` re-check, and both the portal fail-closed guard (`:2803`) and the language guard (`:2761`) are conditioned on `sendContext` being non-null. `buildWorkerSendContext` returns `undefined` when a caller passes no send/scope fields (`:3768-3784`) — which is exactly the Hermes and suggester configuration. So on those two surfaces a hallucinated `send_portal_message` call would fall through all three checks to the real send at `:2807`, using model-supplied ids, producing a client-visible message that auto-emails the client (R103). Same shape for `run_sql_query` at `:2885`. The trigger (a model emitting a tool name it was never offered) is unlikely — but it is this codebase's own stated threat model, repeated a dozen times in its comments, and these two branches are the ones that assume it away.

**Client-scope is narrower than its own file claims.** `checkClientScope` inspects only top-level params named `account_id`/`accountId`/`contact_id`/`contactId`/`client_id`/`clientId`, plus UUIDs inside `run_sql_query`/`crm_query` text (`client-scope.ts:51-55, 80-108`). Every **by-name or by-locator** lookup crosses freely on the pinned surface: `search_accounts({query:'Other Client LLC'})`, `gmail_search`, `search_documents`, `gmail_read({message_id})`, `read_drive_file({file_id})` (`worker-tools.ts:1346`), `read_portal_attachment({url})` (`:1127` — a **model-supplied URL**, allow-listed by hostname only, so any publicly-readable object in our own buckets is reachable and the scope check cannot see it). The file documents only the no-id-SQL gap (`:19-23`); these are larger.

**Document attachment — what the warnings do and don't do.** `offerSearchedDocuments` mints an attach ref for any document the server just returned, stamped with an owner label. Two warnings exist, both **warn-never-block** (`sendable-attachment.ts:490-496`; mixed-client note `worker-email-send.ts:249-255`): a wrong-client warning that only fires when the surface knows the recipient family (`knowsRecipient = family.size > 0`, `:486` — false on a client-less Team Chat thread), and an internal-document warning whose pattern list is **empty by decision** (`INTERNAL_DOCUMENT_PATTERNS`, `:411-418`; Antonio 2026-08-04: "the SS4 visible to the client is ok"). So today no ordinary document is flagged internal, and on an unlinked Team Chat thread neither warning fires.

### Enforced in code, on the answer

All in `runWorkerLoop`, each latching once, all failing **open** on error (`:4289-4292`):

| Guard | Trigger | Where |
|---|---|---|
| Absence-without-looking | asserts absence with zero **succeeded** lookups | `:4211-4221`; evidence set `answer-guards.ts:33` |
| Correction-without-checking | staff pushed back, model re-answered with no lookup | `:4225-4234` |
| Phantom file | claims a file while `artifacts` is empty | `:4248-4257` |
| False surface redirect | points at another screen/bot for a dead action | `:4258-4267` |
| Read-to-the-end | unfinished file read; re-fires while progress is made, capped at 8 | `:4275-4288`; `read-completion.ts:133` |
| Partial-read stamp | server appends "read only X of Y" after the model finishes | `read-completion.ts:212` → `:4318, 4450, 4466` |
| Truncation honesty | `stop_reason: max_tokens` marked | `:4309`, `answer-guards.ts:411` |
| Wall report | only-code-can-fix failures open a `#td-worker-bug` thread | `:4825-4842` |

### Enforced at the route

| Control | Where |
|---|---|
| False-card correction | `worker-chat:1007-1011` |
| Portal draft language-mismatch flag on the card | `:948-958` |
| Card attribution — only a row this turn, this actor created | `:720`, `:909`; Team Chat `claude-trigger:441` |
| Orphan-freeze cancellation | `:983`; Team Chat `claude-trigger:544` and again at `:597-598`, plus a failure note `:610` |
| Client re-resolution before pinning | `sidebar-send-rails.ts:38-49` |
| Loud failure on degraded contact lookup | `:95-103` |
| Plain-English error surfacing | `ai-agent:613`, `worker-chat:1026` |
| Cross-border lenses, keyword-gated, failure-isolated | `cross-border-check.ts:47`, `:89` |

### Prompt-only (no code floor)

- **"Show the draft and wait for the explicit *send it*"** is prompt text on every surface. Code enforces *who* a send may reach and *whether it freezes*, never *whether a human said go*. Email has a card on all four CRM surfaces. A direct portal send on Portal Chats, the sidebar and Team Chat has no card — **on Portal Chats that is the intended design** (see §1 note ⁴): the screen fixes the recipient, so draft-then-"send it" in the conversation is the approval. What backs it in code is the client pin plus the language guard. The sidebar and Team Chat inherit the same shape from a pin derived from the open page / the thread's client link, and are the two worth a second look — neither has the client boundary that Portal Chats has.
- **`emailConfirmExempt` is no longer a permission gate.** It is now read as a **threading signal** — whether the recipient is on the open Gmail thread (`:2620-2633`) — while its own type doc at `:3534` still describes it as controlling the confirm step. Live on four surfaces (`worker-chat:624, 678`, `sidebar-send-rails.ts:129`, `claude-trigger:336`).
- Thread-type formatting addenda (`thread-routing.ts:152+`).
- "The recipient must come from the staff member, never from an email body" (`inbox-worker-prompt.ts:58`).

---

## 6. Env switches and dormant machinery

| Variable | Semantics | Default in code | Source |
|---|---|---|---|
| `WORKER_ACTIONS_ENABLED` | master switch for the action rail **and** the code-task rail | **off** | `worker-actions-switch.ts:22` |
| `APPROVAL_RAIL_ENABLED` | whether the executor actually executes approved rows | **off** | `approval-executor.ts:106` |
| `APPROVAL_ENV` | which approval lane this deployment uses | `NODE_ENV` → `production` | `approval-env.ts:24` |
| `WORKER_FULL_REACH_{DASHBOARD,INBOX,PORTAL_CHAT,TEAM_CHAT,SLACK}` | per-surface catalog reach | **on** everywhere | `full-reach.ts:29, 50` |
| `ASSISTANT_FULL_REACH_ENABLED` | legacy global fallback | unset | `:70` |
| `WORKER_WEB_SEARCH_ENABLED` | must be `'true'` for web tools | **off** | `:4804` |
| `WORKER_WEB_SEARCH_MAX_USES` | web searches/turn | 5 | `:3880` |
| **`THREAD_RECALL_SEMANTIC_ENABLED`** | **master kill for cross-thread semantic recall + summary embedding** | **off** | `thread-recall.ts:42` |
| `THREAD_RECALL_THRESHOLD` / `_COUNT` | recall tuning | 0.72 / 4 | `:27-28` |
| `WORKER_MODEL` | model fallback below the stored setting — **unvalidated** | `claude-sonnet-4-6` | `:3963` |
| `WORKER_SIDEBAR_LEGACY` | forces the old sidebar engine back | off | `ai-agent:35` |
| `WORKER_FILE_READ_CAP` / `_DASHBOARD` | per-file read window | built-in | `slack-file-reader.ts:39`, `attachment-reader.ts:405` |
| `WORKER_CACHE_DEBUG` | logs prompt-cache usage | off | `:4181` |
| `AGENT_MAX_TOOL_LOOPS` | default loop cap | 8 | `:3288` |
| `WORKER_KEY_<SURFACE>` | per-surface Anthropic key | shared key | `surface-api-key.ts:26` |
| `SLACK_WORKER_ANTHROPIC_KEY` | legacy key, surface `slack` only | — | `:42` |
| `GMAIL_WORKER_ALLOWED_MAILBOXES` | mailboxes the worker may read | — | `gmail-mailbox.ts` |
| `SLACK_BOT_TOKEN_CLAUDE` | still consumed by the weekly memory digest | — | `memory-digest/route.ts:77-87` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CRON_SECRET` | base credentials | — | various |

**Deployed values are not verified.** Every row is the code default. The two consequential unknowns are `WORKER_WEB_SEARCH_ENABLED` and `THREAD_RECALL_SEMANTIC_ENABLED`. A behavioural signal on the action rail: `approval_queue` has 22 rows, first 2026-06-05, **last 2026-07-10 12:23** — the day of the switch-off. That is consistent with the rail being off; it is inference, not verification.

**Not an env var, and the one that matters most:** the model is a database row — `app_settings.worker_model` = `claude-fable-5`.

**Cron registry:** `vercel.json` is the schedule; `lib/cron-coverage.ts` is a second registry that must agree with it (Team Chat's runner is declared at `:71`).

| Dormant thing | State | To re-enable |
|---|---|---|
| **Approval rail** | backend intact (`proposeAction:2159`, `approvable-tools.ts`, `approval-executor.ts`, `approval-notifications.ts`, MCP tools `lib/mcp/tools/agent-approvals.ts`, cron `/api/cron/approval-executor` scheduled `*/5`). The tool is not offered to any model (`:2078-2083`) | `WORKER_ACTIONS_ENABLED=true` **and** `APPROVAL_RAIL_ENABLED=true` **and** re-add `PROPOSE_ACTION_TOOL` to `WORKER_TOOLS`. `NO_APPROVAL_SEND_TOOLS` (13, `tool-risk.ts:102`) must stay — approved sends bypass every recipient pin |
| **Code-task rail** | tools defined `:354`, `:372`; no caller enables it (Team Chat sets `false` `:512`); executor refuses on the switch. Both branches read `_currentSlackCtx`, which no live surface populates — `promote_code_branch` returns "No Slack thread context" unconditionally (`:2468`) | a caller flag **plus** the switch **plus** a replacement for the Slack context |
| **Hermes bridge** | crons `/api/cron/hermes-bridge` and `/api/cron/hermes-health` scheduled `*/5`; **no traffic since 2026-07-11**. Its input is created by the MCP tools `agent_msg_send` / `agent_inbox_list` / `agent_inbox_reply` plus `hermes_heartbeat` (R108), all live on the production connector | nothing to enable |
| **Client-thread tagging** | `tag_client_thread` gated on a flag set only inside the dead `processSlackEvent`; and see §8b.7 — it fails on every non-Slack path regardless. `client_threads` holds 801 live rows, read by `find_client_threads` on all four CRM surfaces | a flag **and** a replacement for the Slack thread key |
| **`client-thread-rescue` cron** | route exists, **not in `vercel.json`** — manual only | add a schedule |
| **Legacy sidebar engine** | reachable only via `WORKER_SIDEBAR_LEGACY=true` | one env var; costs capability, not safety (`ai-agent:30-32`) |

---

## 7. Deprecated / dead surfaces, with evidence

**The Slack surface is REMOVED, not dormant.** Commit `51f17a23` deleted the Claude bot's event webhook, the slash-command and interactive endpoints, the `slack-claude-worker` cron and its schedule, the Slack mirror routes and its setting, **and the Slack-side 6-digit approval UI** — note the *rail* itself survives (`approval-executor.ts` + the `*/5` executor cron, §6); only the Slack half went. Production confirms the surface is gone: no `sender='slack'` row since 2026-07-27.

**But the engine is still *named* after Slack and is load-bearing for all four live CRM surfaces.** `slack-claude.ts` exports `SLACK_WORKER_SYSTEM_PROMPT` (`:94`), imported by `inbox-worker-prompt.ts:16` and `claude-trigger.ts:456`. `slack-file-reader.ts`, `slack-staff.ts` and the option name `enableSlackSend` are likewise live. **Deleting by keyword would break every surface at once.**

**Genuinely dead code inside that file:** `processSlackEvent` (`:1800`) has no caller outside `tests/unit/slack-claude-worker.test.ts`. It is the only writer of `_currentSlackCtx` (`:1955`), which has **three** readers: `start_code_task` (`worker-tools.ts:2449`), `promote_code_branch` (`:2465`) and `tagClientThreadFromWorker` (`:1817`). All three therefore fail on every live path.

---

## 8. Potentialities

### 8a. Flag flips — built, gated off

| Capability | Flag | Risk / what must come with it |
|---|---|---|
| **Web research** (`web_search` + `web_fetch`) | `WORKER_WEB_SEARCH_ENABLED=true`; all four CRM surfaces and both suggester lenses already pass `enableWebSearch` | The largest single flip. **The fence does not cover it, twice over:** `UNTRUSTED_RESULT_PREFIXES`/`_NAMES` (`:3904-3908`) contain no web entry, *and* Anthropic server-tool results never become client `tool_result` blocks — `fenceToolResult` runs only inside the client loop (`:4377`) while server blocks re-enter verbatim as assistant content (`:4383`, and on the `pause_turn` path `:4194`). Unfenced fetched web text next to a live send rail is the exposure. **Close this before flipping.** Cost: up to 5 searches/turn × 4 surfaces × 3 calls on a gated suggester turn |
| **Cross-thread semantic recall** | `THREAD_RECALL_SEMANTIC_ENABLED=true` | Requires the `thread_summaries.embedding` migration + `match_thread_summaries` RPC applied and backfilled first (`thread-recall.ts:32-41`) — flipping early wastes an embedding call per turn. Verify the migration state in **both** environments before flipping |
| **Approval rail** | see §6 | Antonio's explicit 2026-07-10 decision was to abandon this path (R108/R111). Do not flip without re-deciding |
| **Per-surface reach kill** | `WORKER_FULL_REACH_PORTAL_CHAT=false` | Already on; the off-switch to reach for first if anything misbehaves (`full-reach.ts:44-48`) |
| **Per-surface model trial** | `CallWorkerOptions.model` | Fully plumbed, unused. One line on one route. Prompt cache splits per model (`:4156`) |
| **Per-surface API key / budget** | `WORKER_KEY_<SURFACE>` | Zero code change; only Team Chat uses it |

*(v1 listed `PolicyConfig.writeInternalAuto` here. It is unreachable: `classifyTool` only ever returns `EXTERNAL` or `READ` (`tool-risk.ts:284-309`), so the `WRITE_INTERNAL` branch at `:328` can never be taken and the flag changes nothing.)*

### 8b. Small builds — machinery exists, a surface doesn't forward it

1. **CRM notes on Team Chat.** Every other surface passes `enableCrmNotes: true`; `claude-trigger.ts` does not. One field.
2. **`clientScope` computed and dropped on the sidebar.** `buildSidebarSendRails` returns a `ClientScope` (`sidebar-send-rails.ts:132`); the route spreads only `rails.portal` and `rails.email` (`ai-agent:479-480`). Documented as deliberate (`:518-530`) — but a live dead return value is one refactor from being mistaken for an active control.
3. **`clientScope` is not in `CallWorkerOptions`.** It reaches `buildWorkerSendContext` only through an untyped spread (`:4812`). It works (`:2438`), but this is precisely the pattern the file's own header warns about (`:3728-3742`).
4. **The suggester passes no `clientKey`** (`suggest:223-231`) — no client recall, no lesson capture, on the surface that is entirely about one client.
5. **Attachments on Hermes and the suggester.** The suggester passes images but never `documents` or `pinnedUploads`; Hermes passes neither.
6. **`pinnedUploads` on Team Chat.** It reads thread files (`claude-trigger:414`) and can attach them (`:410`) but sets no read pin — a long file is attachable but not readable to its end.
7. **Client-thread tagging cannot be revived by a flag alone.** `tagClientThreadFromWorker` returns `"❌ No Slack thread context — can't tag this conversation."` on every non-Slack path (`:1817-1820`). Enabling `enableClientThreadTag` today yields a tool that fails 100% of the time — the same dead-context defect as `promote_code_branch`.
8. **Artifacts are lost on three of four loop exits** (`:4330`, `:4449`, `:4465`) — a defect, not a wiring gap. Separately, the Inbox and Portal Chats route destructures only `reply` (`worker-chat:735`), so even a successfully-returned artifact is discarded there.
9. **Two prompt-cache breakpoints** would restore the cross-turn cache hit the source claims (§3): stable prompt+tools before the breakpoint, volatile memory suffixes after.
10. **A client-side fetch tool** would be fenced automatically — `read_` is already an untrusted prefix (`:3904`) — which is the contained way to close the web-fence gap.
11. **Surface labels are inconsistent.** Routes write `context_json.surface` as `portal-chats`/`team-chat` while passing `surface: 'portal_chat'`/`'team_chat'` to `callWorker` (`worker-chat:759` vs `:561`). Wall reports and DB analytics use different vocabularies.

### 8c. Architecture-bound — the honest ceiling

Split by what actually binds each item.

**Bound by the request model (genuinely structural):**
1. **No persistent session.** Every turn is a stateless HTTP request rebuilding context from the database (`:4571-4635`). Nothing can be held between turns except what a table stores.
2. **~250 s per turn** (`:3296`) under a 300 s route limit — and the per-surface iteration caps are chosen to sit under it, not the other way round. Work needing more than one invocation cannot complete in one turn.
3. **Output ceiling of 16 384 tokens per call** (`:4148`), shared with reasoning on thinking models — the reason the truncation handling exists (`:4295-4308`).
4. **No autonomous action.** It answers when a surface calls it; the only self-starting paths are recovery crons re-processing a stuck row.
5. **No code execution / sandbox / image generation.** File production is limited to what a *tool* makes (`:3839`) — the phantom-file guard exists because the model repeatedly believed otherwise.
6. **Streaming is not supported** (`fetch` + `res.json()`, `:4139`, `:4176`). The binding obstacle is not inspection but **rewriting**: four latching guards send the turn back for a new answer (`:4211-4267`) and the partial-read stamp is appended after the model finishes (`read-completion.ts:212`) — you cannot un-send tokens already streamed.

**Bound by a choice that could be unmade (named with the layer that would change):**
7. **The model cannot spawn subagents — but the route can, and does.** `runCrossBorderChecks` fans out two full worker calls concurrently (`cross-border-check.ts:97-105`). The pattern is `Promise.allSettled(callWorker × N)` behind a gate; adopting it elsewhere is caller-side work. The real limit is that a lens cannot call back into the parent loop — results return only as text.
8. **Guards inspect final text, not intent** (`:4208-4293`). A false claim phrased outside the trigger patterns ships. Widening the patterns is a code change, not a redesign — but the tool trace remains the only non-gameable evidence.
9. **`web_fetch`/`web_search` bypass the fence** — bound only while web research uses Anthropic **server** tools (`:3889`). A client-side fetch tool would be fenced automatically (§8b.10).
10. **One shared model in practice** — because the per-call override is unused and the setting is one row, not because the design forbids per-surface models.

---

## 9. Doc-vs-code and comment-vs-code contradictions

1. **`docs/systems/ai-agent.md` marks shipped code as unshipped — seven banners:** `:3`, `:5`, `:7`, `:9`, `:11`, `:25`, `:27` (dev jobs `7e486d0a`, `d3c313a7`, `d2024649`). Verified against live production, not just the merge: `spreadsheet_create` is exposed by the **production** MCP connector, and banner `:27` (the portal-freeze control) is falsified by production `worker_prepared_sends` carrying `kind='portal'` rows on 2026-08-03/04. `lib/inbox/client-family.ts` and `lib/mcp/tools/documents-generate.ts` both exist on `origin/main`; this worktree at `38e1d536` has zero diff vs main.
2. **`ai-agent/route.ts:41` names an env var that does not exist.** It says `WORKER_SIDEBAR_ENABLED`; the real switch is `WORKER_SIDEBAR_LEGACY` (`:35`) and the worker path is the **default**. The phantom name also appears in `docs/systems/slack-claude-worker.md:38` and `docs/systems/ai-agent.md:97-98`.
3. **Source comments still say the worker runs `claude-sonnet-4-6`** — `worker-tools.ts:8`, `:3233`, `:3885`, `:4477`; `suggest:28`. Live stored model is `claude-fable-5`.
4. **`worker-tools.ts:1-24` describes the file as the Hermes bridge worker with "no sends, no mutations, no DB writes", and `:22-23` says "`run_sql_query` is INTENTIONALLY excluded".** The file now injects a hardened `run_sql_query` (`:4665`) plus `send_email`, `send_portal_message`, `team_chat_send`, six CRM note writes and `tag_client_thread`.
5. **`find_tool`/`use_tool` are documented as "default OFF" (`:2092-2094`).** The live default is **ON for all five surfaces** (`full-reach.ts:50-56`). A reader trusting that comment concludes full catalog reach is off in production.
6. **Tool comments say "Slack-only" for tools no Slack surface can reach** — `send_portal_message` (`:379`), `send_email` (`:443`), `run_sql_query` (`:226`), the Calendly and doc-read blocks. The gating logic is correct; only the prose is wrong.
7. **`emailConfirmExempt`'s own type doc (`:3534`) still describes it as controlling the confirm step**, while `:2620-2624` says explicitly it is "used here as a THREADING signal, never as a permission gate".
8. **Two send-rail files still describe pre-2026-07-29 behaviour.** `sidebar-send-rails.ts:121-124` and `worker-chat/route.ts:677` both say confirm-exempt addresses "send straight out"; `claude-trigger.ts:291-299` says an exempt list without a card "would freeze nothing and simply refuse every third-party address". All three are contradicted by the unconditional freeze at `worker-tools.ts:2534-2540`.
9. **`docs/systems/team-workspace.md:24` still describes the exempt-list model** ("an already-known address sends on the staff member's go-ahead; any NEW address freezes"), which `docs/systems/inbox.md:24` later replaced and the code contradicts.
10. **`mcp-bridge.ts:16` says "this module is not wired in yet"** — it defines the worker's maximum reach and is wired into `find_tool`/`use_tool`.
11. **`tool-risk.ts:153` says "57 of 216 tools passed"**; the set is 59.
12. **`app_settings.slack_mirror_enabled = true`** survives on production for a surface whose routes were deleted; zero readers remain in `app/`, `lib/`, `components/` or `tests/`.
13. **`thread-routing.ts` routes a tool that no longer exists in the set it filters** — `FULL_RESEARCH_NAMES` includes `propose_action` (`:92`, `:120`) while `getToolsForThreadType` filters `WORKER_TOOLS`, from which it was removed. Harmless no-op; misleading to read.
14. **`docs/systems/slack-claude-worker.md`** is titled "RETIRED" and correctly says the engine files stay — accurate, and the counter-example to §7's naming trap.

---

## 10. Things this audit could not verify

- **Deployed environment-variable values on Vercel.** Every switch in §6 is at its code default. `vercel env ls production` would at least prove *existence* (names and targets, not values) — not run here.
- **`WORKER_WEB_SEARCH_ENABLED` and `THREAD_RECALL_SEMANTIC_ENABLED`** — the two consequential unknowns. Both gate capabilities the matrix would otherwise show as live.
- **Whether the `web_fetch` fencing gap has ever been exercised** — depends on the above. No tool-trace column exists on `agent_messages`, and `agent_decisions.tools_used` is written by the legacy dashboard agent, not the worker, so it is not evidence either way.
- **Whether the crons are actually executing.** `vercel.json` proves *scheduling*; `cron_status` was not queried in this pass, so §6's "scheduled" should not be read as "verified running".
- Runtime behaviour of any guard: this was a source read, not an execution trace.

---

## 11. Council record (2026-08-04)

Five reviewers — Senior Engineer, Bug-Hunter, AI Architect, System Counselor, Project Director — reviewed v1 with the brief *"find capabilities the audit missed and claims it didn't cite."* Every finding below was re-verified against source by the author before this revision; the reviewers' line numbers were not taken on trust.

**Blockers fixed in v2:**
1. v1's §1 credited **Portal Chats with a portal Confirm card**. It has none, and sends to the client directly. (Project Director, System Counselor)
   **Corrected again in v3, by Antonio (2026-08-04):** the reviewers and I both read the absent card as a missing safety gate. It is the intended design — the panel is pinned to one client, so the conversation itself is the approval. The factual error (the matrix claimed a card that does not exist) was real; the alarm attached to it was not. See §1 note ⁴ for his wording and for why the Inbox is the case that genuinely needs a card. **Standing lesson: an absent control is not automatically a defect — check whether it was decided before reporting it as a gap.**
2. v1 said **`availableNames` re-checks are universal**. They cover 11 of 17 injected tools; `run_sql_query` and `send_portal_message` fail open, and the portal fail-closed and language guards are themselves conditioned on a send context existing. (Senior Engineer, Bug-Hunter)
3. v1 called **subagents/fan-out architecturally impossible**. Route-level fan-out is shipped and running in the suggester. (AI Architect, System Counselor)

**Also corrected:** Team Chat email is unconditional, not client-linked-only · cross-thread semantic recall is dark by default · the base 33 is replaced, not extended, by thread-type routing · `agent_memory` is a whole second store the map omitted · the Business Brain decays and forgets by default, and its digest still posts to Slack · the document-attach rail was missing from the matrix, its internal-document list is empty and its warnings never block · the email Confirm endpoint has no actor check · `forceMailbox` is overridable by the human at Confirm · artifacts are dropped on three of four loop exits · `writeInternalAuto` is unreachable · "22 never-offered tools" was 15 · seven stale banners in `ai-agent.md`, not five · plus ~a dozen citation corrections, chiefly in the suggester block.

**Reviewer disagreement to record:** the Project Director expects the engineers to classify these as documentation defects rather than system defects — the code behaves as designed and the designs are Antonio's, written down. That is right about the code. It is not a reason to leave the map wrong: a reference that overstates a human gate on client-facing sends is how the next session ships on a false assumption.
