# Mac Mini Hermes Setup Handoff
## From: Claude Dispatch (MacBook) → To: Claude on Mac Mini
## Date: June 5, 2026

---

## CONTEXT — How We Got Here

This handoff comes from a massive build session where the entire Hermes Operating Agent server-side infrastructure was designed, built, tested, and shipped to production.

### The journey (chronological):

1. **Started with the client health audit** — running 34 audit rules across 22 clients, finding systemic data issues. This led to the tax return workflow redesign.

2. **Tax return workflow redesign** (PRs #64-#67) — two separate pipelines (Annual 11 stages, One-Time 8 stages), bridge mapping fixes, installment handler fix, 16 records migrated.

3. **Welcome link feature** (PRs #69-#72) — shareable portal credentials page with AES-256-GCM encryption, resend email creates fresh tokens, reusable WelcomeLinkButton component.

4. **Phase 2 Slices 1-4** (PRs #82-#88) — approval queue + propose_action + approval_decide + executor + direct-trigger + crash-recovery cron + kill switch + formatter + Hermes config. This was the mechanical approval rail.

5. **Antonio's feedback: "what we have built is a stupid worker that can't do anything."** He wanted a three-way conversation system (Antonio ↔ Hermes ↔ Claude), not a queue with buttons. The architecture was redesigned.

6. **Phases A-D** (PRs #89-#92) — schema extensions (thread_id, hermes_instances, thread_summaries), codebase tools for the worker, notifications + CRM mirror, thread intelligence (summaries, type routing, context watermark), prompt versioning + env lanes + batch grouping.

7. **Antonio and Hermes reviewed together** — identified two missing pieces: Hermes must execute locally (not trigger Vercel), and confirmation token needed for hardware-level approval safety.

8. **WP1** (PR #93) — confirmation_code column, hermes_heartbeat + approval_claim + approval_complete MCP tools. E2E tested 32/32 in sandbox.

9. **WP2** (PR #94) — thread_create MCP tool, agent_msg_send thread_id support, Hermes config updates.

### Current state:
- **Server-side: COMPLETE** — 13 PRs merged (#82-#94), 2630+ unit tests, production verified
- **Kill switch APPROVAL_RAIL_ENABLED=true** is ON in production
- **Production commit:** `1ac7f855`

---

## WHAT THE MAC MINI NEEDS TO DO

### Step 1: Add MCP tools to Hermes's include list

Find Hermes's MCP server config (the file that lists which td-operations tools Hermes can use). Add these 5 tools to the existing list:

- `hermes_heartbeat` — writes "I'm alive" to the DB so the health monitor can alert if Hermes goes offline
- `approval_claim` — atomically claims one approved task for local execution (with params_hash integrity check)
- `approval_complete` — marks a claimed task as executed or failed, triggers notifications
- `thread_create` — starts a new conversation thread (investigation, bug_report, client_audit, action_request, internal_ops)
- `thread_search` — searches past thread summaries for institutional memory

These are IN ADDITION TO the existing tools: `approval_list`, `approval_decide`, `agent_msg_send`, `agent_inbox_list`, etc.

### Step 2: Create the approval cron job

Create a cron job that runs every 60 seconds. On each cycle:

```
1. hermes_heartbeat('mac-mini-primary')
   → Writes heartbeat to hermes_instances table
   
2. approval_list(status='pending')
   → Check for new proposals
   → For each new one: show Antonio on Telegram with:
     - Tool name in plain language
     - Key params
     - Risk flags (⚠️ external for send_email, ⚠️ cascades for advance_service_stage)
     - 🔑 Confirmation code (6 digits)
     - "To approve: APPROVE <short_id> <code>"
     - "To reject: REJECT <short_id>"
   → Track which proposals have been shown (avoid re-sending)

3. approval_claim('mac-mini-primary')
   → Claims one approved task (if any)
   → If claimed: execute the tool locally, then call approval_complete
   → If nothing to claim: skip
```

### Step 3: Handle Antonio's approval/rejection

When Antonio says "APPROVE 847291" on Telegram:
- Find the pending proposal with that confirmation code
- Call `approval_decide(id, 'approve', confirmation_code='847291')`
- Server verifies the code matches → flips to approved

When Antonio says "reject" or "deny":
- Call `approval_decide(id, 'reject', note='reason')`
- No code needed for rejection

### Step 4: Thread management (for investigations)

When Antonio reports a bug or asks for an investigation:
1. Call `thread_create(type='bug_report', title='...')` — get thread_id
2. Investigate using CRM tools
3. When Claude's help is needed: call `agent_msg_send(subject='...', body='...', thread_id=thread_id)`
4. The worker receives thread context and responds with filtered tools
5. Show Claude's response to Antonio on Telegram
6. Continue the thread until resolved

### Step 5: Update USER.md

Add to Hermes's operational memory:
- Confirmation code discipline: always show the 6-digit code, never fabricate one, never auto-approve
- Thread management: create threads per investigation, tag messages with thread_id
- New tools: hermes_heartbeat, approval_claim, approval_complete, thread_create, thread_search

### Step 6: Restart Hermes

### Step 7: Verify

After restart:
- Check `hermes_instances` table for a fresh heartbeat row with instance_id='mac-mini-primary'
- Propose a test action and verify the full cycle: propose → show on Telegram → approve with code → claim → execute → complete

---

## THE SAFETY MODEL

```
Claude proposes → pending + 6-digit code generated
    ↓
Hermes shows proposal + code on Telegram
    ↓
Antonio types APPROVE 847291
    ↓
Hermes calls approval_decide with the code → server verifies → approved
    ↓
Hermes cron claims → executes locally → approval_complete
    ↓
Result shown on Telegram + CRM team chat
```

- No valid code = no approval
- Hermes can't fabricate a code (server generates it)
- Claude can't execute without approval
- The Vercel executor is crash-recovery fallback (will be turned off after Hermes is verified)

---

## AFTER VERIFICATION

Once the Mac Mini confirms the heartbeat is writing and one full cycle works:
1. Tell Dispatch (Claude on MacBook) to remove `APPROVAL_RAIL_ENABLED` from Vercel production env
2. This turns off the Vercel executor — Hermes becomes the sole primary executor
3. The Vercel 5-minute cron stays as crash-recovery only (re-claims stuck rows)

---

## REFERENCE

- Full architecture plan: `sysdoc_read('agent-bridge-phase2-plan')`
- Session context: `sysdoc_read('session-context')`
- Production health: `https://td-operations.vercel.app/api/health`
- The 12 approvable tools: create_task, update_task, update_account_notes, update_contact, update_service, advance_service_stage, send_email, drive_move, drive_upload_file, gmail_get_attachments, log_conversation, save_memory
