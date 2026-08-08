# TD Operations — System Atlas
_The master map of the whole system. The **narrative** sections below are curated by hand; the **appendices** are REGENERATED FROM LIVE CODE by `node scripts/generate-system-atlas.mjs` and are checked on every push, so their counts cannot silently rot the way they did between 2026-05-29 and 2026-08-02 (41 vs 49 tool groups, 18 vs 26 hooks, rules stopping at R106 while CLAUDE.md had reached R113). Anything inside a GENERATED block is machine-written — do not hand-edit it, rerun the generator._

This is the single map of the whole system: every feature, where it lives, the rules that govern it, and whether a deep doc exists yet. Status legend: ✅ DONE = full deep doc written · draft card = grounded summary captured, needs finishing · pending = inventory known, deep doc not yet written.

## Systems

### Client lifecycle
- **Leads & lead lifecycle** — Sales funnel from first contact → offer → payment. 3 independent statuses (lead/offer/activation).
  - Lives in: `lib/leads, app/(dashboard)/leads, lib/mcp/tools/leads.ts`
  - Rules: R094 · Deep doc: draft card
- **Offers & contracts** — Offer documents, e-signature, multi-contract bundles; signing ≠ payment.
  - Lives in: `lib/offers, lib/mcp/tools/offers*, app/offer`
  - Rules: R094 · Deep doc: ✅ DONE → [offers.md](offers.md)
- **Formation** — Company formation lead→EIN→active; Harbor Compliance filing; tier advances on EIN.
  - Lives in: `lib/operations/service-delivery.ts, formation-form, lib/mcp/tools/formation*`
  - Rules: R102, R106 · Deep doc: ✅ DONE → [formation.md](formation.md)
- **Onboarding** — Post-formation onboarding form + welcome package.
  - Lives in: `app/onboarding-form, lib/mcp/tools/onboarding*, welcome-package`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [onboarding.md](onboarding.md)
- **Lease & Operating Agreement** — Lease + OA generation, send, e-signature via safeSend.
  - Lives in: `lib/mcp/tools/lease*, oa*, lib/mcp/safe-send.ts, app/lease, app/oa`
  - Rules: R037 · Deep doc: ✅ DONE → [lease-oa.md](lease-oa.md)
- **E-Sign (internal e-signature engine)** — In-house DocuSign-class engine: visual field placement, multi-signer, templates, server flatten + Certificate of Completion. Multi-tenant schema (`owner_account_id`/`origin`); TD-first live, client product is Phase 5. **LIVE on production (2026-06-27).**
  - Lives in: `lib/esign, lib/operations/esign.ts, app/(dashboard)/tools/esign, app/sign, app/portal/sign/esign`
  - Rules: R005, R037, R041, R107 · Deep doc: ✅ DONE → [esign.md](esign.md)

### Finance
- **Banking & bank-feed** — Bank applications + transaction feed reconciliation / invoice matching.
  - Lives in: `lib/finance, lib/mcp/tools/bank-statement*, app/(dashboard)/reconciliation`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [banking-bankfeed.md](banking-bankfeed.md)
- **Billing & invoicing** — 3 invoice domains: payments (TD receivables) · client_invoices (client sales) · client/td expenses.
  - Lives in: `lib/portal/td-invoice.ts, unified-invoice.ts, invoice-number.ts`
  - Rules: R027, R092, R098 · Deep doc: ✅ DONE → [billing-invoicing.md](billing-invoicing.md)
- **Tax returns & filings** — Tax forms, quotes, extensions, send-to-accountant.
  - Lives in: `lib/tax, lib/mcp/tools/tax*, app/tax-form`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [tax-returns.md](tax-returns.md)

### Portal & engagement
- **Client portal** — Client-facing app: tiers, chat, documents, invoices, notifications.
  - Lives in: `lib/portal, app/portal, lib/operations/sync-tier.ts`
  - Rules: R100, R102, R103 · Deep doc: ✅ DONE → [portal.md](portal.md)
- **To-Do board / Notification Center** — Staff action cards from chats/events; catalog-driven kanban columns.
  - Lives in: `components/dashboard/action-board.tsx, lib/notifications, message_actions`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE
- **Referrals & Circleback** — Referral program + Calendly intake; 10% credit-note payouts.
  - Lives in: `lib/mcp/tools/referral*, lib/calendly, app/invitation`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [referrals-circleback.md](referrals-circleback.md)
- **Documents & storage** — Drive storage, OCR, classification, doc processing.
  - Lives in: `lib/pdf, lib/mcp/tools/doc*/drive*/classify*/docai`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [documents.md](documents.md)
- **Partners & team access** — Partner accounts, payouts, portal team members.
  - Lives in: `lib/partners, lib/mcp/tools/referral*, portal_team_send`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [partners-team.md](partners-team.md)

### Platform & cross-cutting
- **Workflow / catalog engine** — Catalog-driven workflows: actions, SLA, follow-ups all in catalog_entries JSONB; visual editor.
  - Lives in: `lib/catalog/framework.ts, lib/tasks, app/workflows`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [workflow-engine.md](workflow-engine.md)
- **CRM core** — Accounts, contacts, tasks, deals + activity log; contact identity/merge.
  - Lives in: `lib/mcp/tools/crm*, lib/per-record-activity, app/(dashboard)/accounts`
  - Rules: R018 · Deep doc: ✅ DONE → [crm-core.md](crm-core.md)
- **MCP tool server** — 41 active tool groups (~217 tools) over one transport; instructions + safe-send.
  - Lives in: `app/api/[transport]/route.ts, lib/mcp`
  - Rules: R096 · Deep doc: ✅ DONE → [mcp-tools.md](mcp-tools.md)
- **Hooks, guardrails & safety** — 18 Claude hooks + pre-push gates + sandbox enforcement + 35 R-rules.
  - Lives in: `.claude/hooks, .husky/pre-push, .claude/settings.json`
  - Rules: R104, R105, R107 · Deep doc: ✅ DONE → [hooks-guardrails.md](hooks-guardrails.md)
- **Auth & OAuth 2.1** — Dual auth: Bearer (Claude Code) + OAuth 2.1 (Claude.ai); staff vs client.
  - Lives in: `middleware.ts, app/api/oauth, lib/auth.ts`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [auth-oauth.md](auth-oauth.md)
- **Data model** — 164 tables (generated types are ground truth).
  - Lives in: `lib/database.types.ts`
  - Rules: _(none specific)_ · Deep doc: see appendix
- **Compliance & renewals** — RA renewal, state annual reports, deadlines, calendar sync.
  - Lives in: `lib/harbor-compliance, lib/mcp/tools/hc*/deadline*/calendar*`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [compliance-renewals.md](compliance-renewals.md)
- **AI agent / Antonio Brain** — Internal AI assistant / proactive intelligence.
  - Lives in: `lib/ai-agent`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [ai-agent.md](ai-agent.md)

## Appendix A — MCP tools
<!-- GENERATED:mcp-tools -->
_Regenerated 2026-08-07. Source of truth: uncommented `register*Tools(server)` in `app/api/[transport]/route.ts` (never a grep across tool files — an unregistered file is not active)._

**49 active tool groups**, **220 distinct tool names defined** in `lib/mcp/tools/` (a definition count, NOT a registration count — an unregistered file would inflate it; the group list below is the authoritative active set).

`AgentApproval` · `AgentMessage` · `AgentThread` · `BankStatement` · `BankingForm` · `Calendar` · `Calendly` · `Catalog` · `Checkpoint` · `Circleback` · `Classify` · `Closure` · `CodebaseRead` · `Crm` · `Deadline` · `DevTask` · `Doc` · `Docai` · `DocumentGeneration` · `Drive` · `Formation` · `Gmail` · `HarborCompliance` · `HermesRead` · `ITINForm` · `Job` · `Knowledge` · `Lead` · `Lease` · `Lock` · `MemberInfo` · `Messaging` · `Oa` · `Offer` · `Onboarding` · `Operations` · `Portal` · `Referral` · `Signature` · `Sql` · `Ss4` · `Storage` · `Sysdoc` · `Tax` · `TaxQuote` · `TeamChat` · `Testing` · `WelcomePackage` · `Whop`
<!-- /GENERATED:mcp-tools -->

## Appendix B — Hooks & guardrails
<!-- GENERATED:hooks -->
_Regenerated 2026-08-07. Files in `.claude/hooks/` (test harnesses excluded); "registered" = referenced by a command in `.claude/settings.json`._

**26 hook scripts**, of which **24 are registered** in settings.

**assumption-check.sh** · **bash-production-guard.sh** · **checkpoint-counter.sh** · **council-advisor.sh** · **council-roster.sh** · **counselor-readonly-guard.sh** · **dev-board-index.sh** · **main-repo-change-detector.sh** · **post-push-qa.sh** · pre-commit-audit.sh · **pre-compact-save.sh** · **production-write-guard.sh** · **r093-verifier.sh** · **r093_verifier.py** · **r095-gate.sh** · **r095_gate.py** · **reviewer-health.sh** · **send-guard.sh** · **session-git-pull.sh** · **stop-check.sh** · stop-enforcement.sh · **system-docs-index.sh** · **user-prompt-contract.sh** · **verify-before-edit.sh** · **worktree-write-guard.sh** · **worktree_write_guard.py**

_(bold = registered and firing; plain = present but not wired, e.g. a manual utility)_
<!-- /GENERATED:hooks -->

## Appendix C — Surface area
<!-- GENERATED:surface -->
_Regenerated 2026-08-07 by directory scan._

- CRM dashboard pages (46): `accounts` `addresses` `audit` `bank-feeds` `calendar` `cases` `catalog` `client-health` `clients` `code-tasks` `config` `contacts` `conversations` `dashboard` `dev-board` `dev-tools` `email-templates` `exceptions` `finance` `flows` `inbox` `intake` `invoice-aging` `invoice-settings` `leads` `notes` `owner` `partners` `payments` `pipeline` `pipeline-overview` `portal-chats` `portal-launch` `reconciliation` `referrals` `service-catalog` `services` `system-health` `tasks` `tax-returns` `team-chat` `team-management` `tools` `trackers` `workflow-issues` `workflows`
- Client portal pages (32): `activity` `addresses` `banks` `billing` `change-password` `chat` `company` `customers` `deadlines` `documents` `flows` `forgot-password` `form` `guide` `invoices` `itin-documents` `login` `members` `notifications` `offer` `partner` `profile` `referrals` `reset-password` `services` `settings` `sign` `tax-documents` `tax-financials` `td-communication` `team` `wizard`
- API route groups (78)
- Code modules (65): `ai-agent` `audit` `auth` `billing` `calendly` `case-view` `catalog` `chat` `circleback` `code-tasks` `cron` `decisions` `dev-tracker` `diagnostics` `documents` `email` `email-index` `email-store` `errors` `esign` `exceptions` `fax` `finance` `flows` `formation` `forms` `harbor-compliance` `hooks` `inbox` `itin` `jobs` `leads` `lease` `mcp` `members` `messaging` `nav` `notes` `notifications` `oa` `offers` `operations` `partners` `payments` `pdf` `per-record-activity` `portal` `portal-chats` `public-forms` `push` `schemas` `security` `services` `ss4` `storage` `supabase` `system-health` `tasks` `tax` `td-communication` `team` `todo-board` `types` `ui` `utils`
- Database tables: 172 _(ground truth: `lib/database.types.ts`)_
<!-- /GENERATED:surface -->

## Seed priority — write these deep docs first
Ordered by money + client risk + change frequency:
1. **Billing & invoicing** — touches money + 3 invoice domains are easy to confuse (R027/R092/R098).
2. **Formation** — core product, multi-step, tier/EIN side-effects.
3. **Offers & contracts** — money entry point; signing≠payment (R094).
4. **Banking & bank-feed** — money matching, recent bug surface.
5. **Tax returns** — client-facing, seasonal, accountant handoff.
6. **Client portal** — tiers/chat/docs, high client visibility (R100/R102/R103).
7. **Referrals & Circleback** — payouts; rules partly only in Antonio's head.
8. **Workflow / catalog engine** — powers many flows; understanding it unlocks the rest.

## Status — all systems documented (2026-05-29)
Every system listed above now has a deep doc under `docs/systems/`, each written by reading the live code (not the automated sweep — those drafts were superseded). The `leads` deep doc is the one remaining one-liner-only entry (covered by a grounded draft card); write it from code when leads is next touched.
- Business rules that live only in Antonio's head (e.g. some Circleback specifics) still need capturing into the knowledge base — flag them as you hit them.
- "Last verified against code" dates on each doc are the trust anchor: re-verify before acting on anything older than your change.

## Appendix D — Guardrail rules
<!-- GENERATED:rules -->
_Regenerated 2026-08-07 from the R-rule list in CLAUDE.md — **42 rules**, highest is R113._

- **R005** — td-operations.vercel.app is INTERNAL: NEVER send this domain to clients. {file:lib/config.ts}
- **R012** — All client-facing URLs MUST use APP_BASE_URL from {file:lib/config.ts} — never hardcode domains; the .husky/pre-push hook blocks hardcoded domains.
- **R015** — NEVER remove any domain from Vercel — old links must always work.
- **R016** — All URLs, tokens, and slugs must be in English.
- **R018** — NEVER use {tool:execute_sql} for CRM writes — always use {tool:crm_update_record}.
- **R027** — client_invoices is for client sales invoices ONLY — TD systems NEVER write here. {table:client_invoices} {file:lib/portal/unified-invoice.ts}
- **R035** — NEVER send a form to a client without testing it first via ?preview=td.
- **R037** — All MCP send tools MUST use safeSend() from {file:lib/mcp/safe-send.ts}: idempotency check → send FIRST → status update AFTER → multi-step tracking. NEVER mark a record "sent" before the actual send operation.
- **R041** — Email Subject headers MUST be RFC 2047 base64 encoded — applies to ALL email senders (API routes, cron jobs, MCP tools, server actions, no exceptions).
- **R051** — Subagents must write results to Supabase BEFORE returning. Chat gets a compact summary.
- **R053** — Before INSERT on {table:dev_tasks}, SELECT first to check if a task on the same topic already exists. If it does → UPDATE. Never duplicate.
- **R060** — Master Rules KB (370347b6) is the CANONICAL source for business rules — wins on conflict. {table:knowledge_articles}
- **R067** — When you modify an existing file, fix any ESLint warnings in that file (lint-staged blocks the commit otherwise).
- **R070** — Run git pull origin main BEFORE any work, every session (enforced by SessionStart hook session-git-pull.sh).
- **R071** — NEVER use git add -A or git add . — stage specific files by name only. Never commit files you didn't intentionally modify.
- **R076** — NEVER run git push --force — branch protection blocks it and it would destroy other machines' work.
- **R079** — Every UI feature MUST be tested in the browser (screenshot + interaction) before declaring it done.
- **R086** — Write unit tests for every new function in lib/. Push without unit tests is blocked by the pre-push hook.
- **R089** — Never use Make, Zapier, n8n — all automation via Supabase Edge Functions.
- **R090** — Never commit .env.local or credentials.
- **R091** — Never create README.md or documentation files unless asked.
- **R092** — Client invoice emails MUST direct clients to the portal to pay (portal.tonydurante.us → Fatture/Invoices → Expenses). NEVER embed Stripe checkout links, wire transfer details, or any payment credentials directly in the email body. …_(truncated — read the full rule in CLAUDE.md)_
- **R093** — NO ASSUMPTIONS. EVER. Every column name, table schema, enum value, file path, function signature, API behavior, workflow semantic, client state, or past action must be verified by a FRESH tool call in the CURRENT session before use. …_(truncated — read the full rule in CLAUDE.md)_
- **R094** — leads.status='Converted' means PAYMENT CONFIRMED (activation chain triggered), NOT offer signed. …_(truncated — read the full rule in CLAUDE.md)_
- **R096** — MCP TOOL ROUTING — TWO CONNECTIONS, CLAUDE CHOOSES (2026-05-01). Claude Code has two MCP connections: mcp__td-ops-sandbox__* (sandbox Supabase, generated by dev-setup.sh into .mcp.json) and mcp__af7d85f2-* (DXT plugin, production Supabase). …_(truncated — read the full rule in CLAUDE.md)_
- **R097** — QB MCP tools REMOVED (2026-04-24, commit 8f9f18a). qb.ts and qb-expenses.ts (17 tools) moved to lib/mcp/tools/deprecated/ and unregistered from the MCP server (the orphaned active copies were deleted 2026-06-03). …_(truncated — read the full rule in CLAUDE.md)_
- **R098** — Invoice-number generator is race-safe via DB unique constraint, NOT a retry loop in code. lib/portal/invoice-number.ts::generateInvoiceNumber is intentionally simple (max+1) with strict LIKE 'INV-______' filter; …_(truncated — read the full rule in CLAUDE.md)_
- **R099** — Surface server errors on client-side fetch (2026-04-21, commit b80ecef). Any client-side fetch to our own APIs must parse the server's JSON body on non-2xx and surface data.error to the user, with a sensible fallback. …_(truncated — read the full rule in CLAUDE.md)_
- **R100** — Client-visible content deletion MUST use soft-delete (2026-04-21, commit 49d64df). …_(truncated — read the full rule in CLAUDE.md)_
- **R101** — DEVIL'S ADVOCATE MANDATORY (2026-04-21). Before any plan, proposal, decision, or recommendation, you MUST internally answer five questions: (1) what am I assuming, (2) what did I consider and reject, (3) how is my chosen approach weak, (4)  …_(truncated — read the full rule in CLAUDE.md)_
- **R102** — Portal tier has exactly 4 values: lead, formation, onboarding, active. The value full is removed and must never be used. …_(truncated — read the full rule in CLAUDE.md)_
- **R103** — When an admin sends a portal chat message (via dashboard or portal_chat_send MCP tool), the client automatically receives an email notification. Implemented in lib/portal/notifications.ts::notifyClientOfAdminMessage. …_(truncated — read the full rule in CLAUDE.md)_
- **R104** — SANDBOX IS THE ONLY DEVELOPMENT ENVIRONMENT (2026-05-01, structural enforcement). Three layers prevent production access during development: (1) .vercel/project.json is committed to git with sandbox values — git pull resets it on every mach …_(truncated — read the full rule in CLAUDE.md)_
- **R105** — ALL DDL MUST GO THROUGH MIGRATION FILES (2026-04-30, structural enforcement). CREATE TABLE, ALTER TABLE, CREATE FUNCTION/TRIGGER/VIEW/SEQUENCE/TYPE/EXTENSION, and CREATE INDEX are blocked by execute_sql unless reason starts with migration:< …_(truncated — read the full rule in CLAUDE.md)_
- **R106** — Service/SD vocabulary lives in the catalog framework. The source of truth for service types is catalog_entries (catalog_id='services'). Code MUST import from lib/services/index.ts — never hardcode service type strings. …_(truncated — read the full rule in CLAUDE.md)_
- **R107** — SYSTEM REFERENCE LIBRARY (2026-05-29, structural enforcement). docs/systems/ holds one living doc per subsystem (how it works, how it's built, the rules, how to verify). …_(truncated — read the full rule in CLAUDE.md)_
- **R108** — Hermes ↔ Claude BRIDGE (Phase 1, 2026-06-03, dev_task 1a0d1354). One table (agent_messages) + three MCP tools (agent_msg_send, agent_inbox_list, agent_inbox_reply) + one cron worker (/api/cron/hermes-bridge, schedule */5 * * * *) implement  …_(truncated — read the full rule in CLAUDE.md)_
- **R109** — SELF-SERVE BEFORE ASKING (2026-06-21). Never ask the user for a fact the system can give you — a client's language (contacts.language), email, invoice/payment status, which service they have, any record state. …_(truncated — read the full rule in CLAUDE.md)_
- **R110** — OFFER WORKTREE TEARDOWN WHEN A JOB SHIPS (2026-06-27). Each Claude Code worktree may run its own isolated local Supabase stack (auto-provisioned by scripts/worktree-auto-isolate.sh, ~8 GB RAM each). …_(truncated — read the full rule in CLAUDE.md)_
- **R111** — WORKER NEVER LAUNCHES OR SHIPS CODE (**AMENDED 2026-07-10, Antonio** — supersedes the 2026-06-30 Antonio-only gate). …_(truncated — read the full rule in CLAUDE.md)_
- **R112** — DEV-TRACKER BOARD DISCIPLINE (2026-07-11). Every Claude Code session that does dev work (feature/bug/refactor/etc.) MUST be tied to exactly ONE dev job in dev_tasks — the durable, compaction-proof record shown on the /dev-board board (per-c …_(truncated — read the full rule in CLAUDE.md)_
- **R113** — ASK THE SYSTEM COUNSELOR FIRST, ON EVERY INVESTIGATION (2026-08-02). Before forming a theory about any investigation — bug, "how does X work", audit, or a feature touching an existing flow — consult the system-counselor subagent FIRST, in c …_(truncated — read the full rule in CLAUDE.md)_
<!-- /GENERATED:rules -->

## Appendix E — Subsystem deep docs
<!-- GENERATED:deep-docs -->
_Regenerated 2026-08-07. Every subsystem doc under `docs/systems/` (36 docs), with the date each was last verified against code — **an old date means treat that doc as a hint and check the code**._

- [agent-bridge.md](agent-bridge.md) — Hermes ↔ Claude Agent Bridge _(verified 2026-08-07)_
- [ai-agent.md](ai-agent.md) — AI Agent (in-dashboard assistant) _(verified 2026-08-07)_
- [auth-oauth.md](auth-oauth.md) — Auth & OAuth _(verified 2026-08-07)_
- [banking-bankfeed.md](banking-bankfeed.md) — Banking & Bank-Feed Reconciliation _(verified 2026-08-04)_
- [billing-invoicing.md](billing-invoicing.md) — Billing & Invoicing _(verified 2026-07-29)_
- [client-decision-requests.md](client-decision-requests.md) — Client Decision Requests _(verified 2026-06-22)_
- [client-threads.md](client-threads.md) — Client Threads _(verified 2026-07-31)_
- [compliance-renewals.md](compliance-renewals.md) — Compliance, Renewals & Deadlines _(verified 2026-08-07)_
- [crm-core.md](crm-core.md) — CRM Core — Accounts, Contacts, Tasks, Deals _(verified 2026-07-17)_
- [dev-tracker.md](dev-tracker.md) — Dev-Tracker Board _(verified 2026-07-16)_
- [documents.md](documents.md) — Documents & Storage _(verified 2026-08-04)_
- [error-auto-audit.md](error-auto-audit.md) — Error Auto-Audit _(verified 2026-07-11)_
- [esign.md](esign.md) — E-Sign (internal e-signature engine) _(verified 2026-08-03)_
- [fax.md](fax.md) — Fax (Faxage integration) _(verified 2026-07-09)_
- [flows.md](flows.md) — Service Flow Workspaces _(verified 2026-08-06)_
- [formation.md](formation.md) — Company Formation _(verified 2026-08-06)_
- [hooks-guardrails.md](hooks-guardrails.md) — Hooks, Guardrails & Safety System _(verified 2026-08-02)_
- [inbox.md](inbox.md) — Inbox (CRM unified inbox — Gmail + WhatsApp/Telegram) _(verified 2026-08-07)_
- [lease-oa.md](lease-oa.md) — Lease & Operating Agreement (OA) _(verified 2026-07-26)_
- [mcp-tools.md](mcp-tools.md) — MCP Tool Server _(verified 2026-07-29)_
- [messaging.md](messaging.md) — Messaging (WhatsApp / Telegram) _(verified 2026-07-29)_
- [offers.md](offers.md) — Offers & Contracts _(verified 2026-08-06)_
- [onboarding.md](onboarding.md) — Onboarding _(verified 2026-07-30)_
- [partners-team.md](partners-team.md) — Partners & Team Access _(verified 2026-07-08)_
- [pnl-engine.md](pnl-engine.md) — P&L / Balance Sheet — Excel export engine _(verified 2026-07-02)_
- [portal.md](portal.md) — Client Portal _(verified 2026-08-07)_
- [pwa.md](pwa.md) — PWA (installable app shell — dashboard + portal) _(verified 2026-07-21)_
- [referrals-circleback.md](referrals-circleback.md) — Referrals & Circleback _(verified 2026-08-06)_
- [slack-claude-worker.md](slack-claude-worker.md) — Slack Claude Worker — RETIRED (surface removed 2026-07-29) _(verified 2026-08-05)_
- [staff-notes.md](staff-notes.md) — Staff Sticky Notes (floating post-its) _(verified 2026-07-29)_
- [tax-returns.md](tax-returns.md) — Tax Returns & Filings _(verified 2026-08-06)_
- [td-books.md](td-books.md) — TD Books (My Finances — the owner's company books) _(verified 2026-07-29)_
- [td-communication.md](td-communication.md) — TD Communication _(verified 2026-08-02)_
- [team-workspace.md](team-workspace.md) — Team Workspace (internal Slack-replacement chat) _(verified 2026-08-04)_
- [todo-board.md](todo-board.md) — To-Do Board — "TO DO — FROM CHATS" (staff action cards) _(verified 2026-08-07)_
- [workflow-engine.md](workflow-engine.md) — Workflow / Catalog Engine _(verified 2026-07-22)_
<!-- /GENERATED:deep-docs -->
