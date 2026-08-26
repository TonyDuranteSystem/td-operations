# System Reference Library

**Purpose.** One living document per subsystem describing *what it does, how it
works, the rules that govern it, and how to verify its current state.* A session
working on a subsystem **reads its doc first** instead of re-deriving the system
from the database and code every time. Turn a 3-hour rediscovery into a 10-minute
read-and-verify.

This is the answer to: *"every session has to read the whole database to understand
how a feature works before it can fix a bug."*

---

## Why these docs live in the repo (not in Supabase sysdocs)

The Supabase `system_docs` collection rots because it is **physically separated from
the code** — nobody updates it in the same change that alters the code. These docs
live **next to the code, in git**, so:

- they travel with branches and worktrees,
- they are updated in the **same commit** as the code change (docs-as-code),
- a wrong doc shows up in the same diff as the code that made it wrong.

The Supabase sysdocs / session logs remain useful as **history**. These repo docs
are the **current "how it works" reference**.

---

## How to use these docs (read-first + verify)

1. **Before working on a subsystem, read `docs/systems/<subsystem>.md` first.**
2. These docs **orient** you; they do **not** authorise action. R093 still rules:
   before you act on real data, verify the one fact you depend on against the live
   system. The doc's **"How to verify current state"** section makes that a 5-minute
   targeted check instead of a from-scratch audit.
3. **If you find the doc is wrong, fix it in the same change** and bump
   "Last verified against code." Docs get *fresher with use* instead of rotting.

---

## How the library stays current (structural, not willpower)

- **Definition of done includes the doc.** If you changed a subsystem's behaviour,
  schema, or rules, update its doc in the same commit. A 130-doc graveyard is what
  happens when this is optional — keep it part of "done."
- **Just-in-time seeding, no boil-the-ocean.** We do NOT document all systems up
  front (that effort would rot before it finished). We seed the **highest-traffic
  systems first**, then: *any time we touch a subsystem that has no doc, writing the
  doc is part of that job* — the knowledge is freshest exactly then.
- **One doc per subsystem. Strict template. Keep it small.** A small wrong doc is
  obvious; a giant one hides its own errors.
- **Date-stamped.** Every doc carries "Last verified against code: YYYY-MM-DD."

---

## Template (copy for every new subsystem doc)

```markdown
# <Subsystem name>
_Last verified against code: YYYY-MM-DD — <who>_

## What it is
One paragraph, plain English: the business purpose.

## Business rules
The rules that govern it (pricing, eligibility, who-can-do-what). Link to the
canonical KB article where one exists — don't duplicate, point.

## How it's built
- **Tables / columns:** the data it lives in.
- **Key files:** exact paths (UI, API, server logic).
- **Config / catalog:** any catalog_entries or env that drives behaviour.
- **Data flow / triggers:** what happens, in order, on the main actions.

## Gotchas, invariants & past bugs
The non-obvious things. Past bugs and *why* they happened (so we don't repeat them).

## How to verify current state
The exact queries / files to check to confirm this doc still matches reality.
```

---

## Start here

**[SYSTEM-ATLAS.md](SYSTEM-ATLAS.md)** — the master map of the whole system: every feature, where it lives, the rules that govern it, the full MCP tool / hook / guardrail / table inventory (exact counts, extracted from code), and the priority order for writing the deep docs. Read the atlas to find which system you need, then open that system's deep doc below.

## Index

| Doc | Subsystem | Status |
|---|---|---|
| [SYSTEM-ATLAS.md](SYSTEM-ATLAS.md) | Master map of every system + tool/hook/guardrail/table inventory | ✅ generated |
| [todo-board.md](todo-board.md) | Dashboard "TO DO — FROM CHATS" board (staff action cards) | ✅ written |
| [billing-invoicing.md](billing-invoicing.md) | Billing & invoicing — the 4 money domains, invoice numbers, credit netting | ✅ written |
| [formation.md](formation.md) | Company formation lifecycle — signed→EIN→active, the EIN hand-off, tiers | ✅ written |
| [offers.md](offers.md) | Offers & contracts — publish→sign→pay→activate, the 3 states (R094) | ✅ written |
| [banking-bankfeed.md](banking-bankfeed.md) | Banking applications + bank-feed auto-reconciliation (matcher, td_bank_feeds) | ✅ written |
| [pnl-engine.md](pnl-engine.md) | P&L / Balance Sheet engine — one `buildPnlWorkbook`, `/tools/pnl` (client + external), K-1/M-2 | ✅ written |
| [td-books.md](td-books.md) | TD Books (My Finances) — `td_books_transactions`, invoice-first routing target, S-corp books foundation | ✅ written |
| [tax-returns.md](tax-returns.md) | Tax returns — status pipeline, accountant hand-off, tax pause + installment resume | ✅ written |
| [portal.md](portal.md) | Client portal — 4 tiers (R102), syncTier, chat/notifications/docs, account types | ✅ written |
| [referrals-circleback.md](referrals-circleback.md) | Referrals — 10% credit notes, partner commissions, Calendly intake | ✅ written |
| [workflow-engine.md](workflow-engine.md) | Catalog framework + workflow engine — triggers, dispatch, snapshots, validity gate, editor | ✅ written |
| [crm-core.md](crm-core.md) | CRM core — accounts/contacts/tasks/deals, account_contacts M:N, crm_update_record (R018) | ✅ written |
| [hooks-guardrails.md](hooks-guardrails.md) | Safety system — Claude hooks, pre-push gates, sandbox enforcement, R-rules | ✅ written |
| [auth-oauth.md](auth-oauth.md) | Auth — Supabase session RBAC (middleware) + MCP Bearer/OAuth 2.1 PKCE | ✅ written |
| [documents.md](documents.md) | Documents & storage — Drive/Supabase storage, OCR+classify pipeline, PDF gen | ✅ written |
| [compliance-renewals.md](compliance-renewals.md) | Compliance — Harbor Compliance, RA/annual-report renewals (cron-driven), deadlines | ✅ written |
| [onboarding.md](onboarding.md) | Onboarding — existing-LLC clients, form→review→active (vs formation) | ✅ written |
| [lease-oa.md](lease-oa.md) | Lease & Operating Agreement — generate, send (safeSend), track, sign | ✅ written |
| [mcp-tools.md](mcp-tools.md) | MCP tool server — endpoint, dual auth, registration/source-of-truth, R096 routing | ✅ written |
| [partners-team.md](partners-team.md) | Partner payouts + internal team messaging + (planned) Portal Team Access | ✅ written |
| [ai-agent.md](ai-agent.md) | In-dashboard AI assistant — Claude/GPT-4o, own tool set, staff-only | ✅ written |
| [research-console.md](research-console.md) | Research Console — admin filter/search builder across CRM record types, view modes, Excel export | ✅ written |
| [whats-new.md](whats-new.md) | What's New — per-client chat-event feed (`portal_messages` markers), distinct from the Notification Center board (todo-board.md) | ✅ written |
| _formation.md_ | Company formation lifecycle (lead → EIN → active) | ⬜ to seed |
| _onboarding.md_ | Onboarding flow | ⬜ to seed |
| _billing-invoicing.md_ | payments / client_invoices / client_expenses / td_expenses | ⬜ to seed |
| _portal.md_ | Client portal (tiers, chat, documents, invoices) | ⬜ to seed |
