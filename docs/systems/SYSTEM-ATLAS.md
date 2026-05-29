# TD Operations — System Atlas
_Generated 2026-05-29 from the live code (deterministic extraction — counts and inventories are exact, not estimated). Per-system "how it works" detail lives in the deep docs under `docs/systems/`; this is the master map that points to them._

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
  - Rules: _(none specific)_ · Deep doc: pending
- **Lease & Operating Agreement** — Lease + OA generation, send, e-signature via safeSend.
  - Lives in: `lib/mcp/tools/lease*, oa*, lib/mcp/safe-send.ts, app/lease, app/oa`
  - Rules: R037 · Deep doc: pending

### Finance
- **Banking & bank-feed** — Bank applications + transaction feed reconciliation / invoice matching.
  - Lives in: `lib/finance, lib/mcp/tools/bank-statement*, app/(dashboard)/reconciliation`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE → [banking-bankfeed.md](banking-bankfeed.md)
- **Billing & invoicing** — 3 invoice domains: payments (TD receivables) · client_invoices (client sales) · client/td expenses.
  - Lives in: `lib/portal/td-invoice.ts, unified-invoice.ts, invoice-number.ts`
  - Rules: R027, R092, R098 · Deep doc: ✅ DONE → [billing-invoicing.md](billing-invoicing.md)
- **Tax returns & filings** — Tax forms, quotes, extensions, send-to-accountant.
  - Lives in: `lib/tax, lib/mcp/tools/tax*, app/tax-form`
  - Rules: _(none specific)_ · Deep doc: pending

### Portal & engagement
- **Client portal** — Client-facing app: tiers, chat, documents, invoices, notifications.
  - Lives in: `lib/portal, app/portal, lib/operations/sync-tier.ts`
  - Rules: R100, R102, R103 · Deep doc: pending
- **To-Do board / Notification Center** — Staff action cards from chats/events; catalog-driven kanban columns.
  - Lives in: `components/dashboard/action-board.tsx, lib/notifications, message_actions`
  - Rules: _(none specific)_ · Deep doc: ✅ DONE
- **Referrals & Circleback** — Referral program + Calendly intake; 10% credit-note payouts.
  - Lives in: `lib/mcp/tools/referral*, lib/calendly, app/invitation`
  - Rules: _(none specific)_ · Deep doc: draft card
- **Documents & storage** — Drive storage, OCR, classification, doc processing.
  - Lives in: `lib/pdf, lib/mcp/tools/doc*/drive*/classify*/docai`
  - Rules: _(none specific)_ · Deep doc: pending
- **Partners & team access** — Partner accounts, payouts, portal team members.
  - Lives in: `lib/partners, lib/mcp/tools/referral*, portal_team_send`
  - Rules: _(none specific)_ · Deep doc: draft card

### Platform & cross-cutting
- **Workflow / catalog engine** — Catalog-driven workflows: actions, SLA, follow-ups all in catalog_entries JSONB; visual editor.
  - Lives in: `lib/catalog/framework.ts, lib/tasks, app/workflows`
  - Rules: _(none specific)_ · Deep doc: pending
- **CRM core** — Accounts, contacts, tasks, deals + activity log; contact identity/merge.
  - Lives in: `lib/mcp/tools/crm*, lib/per-record-activity, app/(dashboard)/accounts`
  - Rules: R018 · Deep doc: pending
- **MCP tool server** — 41 active tool groups (~217 tools) over one transport; instructions + safe-send.
  - Lives in: `app/api/[transport]/route.ts, lib/mcp`
  - Rules: _(none specific)_ · Deep doc: see appendix
- **Hooks, guardrails & safety** — 18 Claude hooks + pre-push gates + sandbox enforcement + 35 R-rules.
  - Lives in: `.claude/hooks, .husky/pre-push, .claude/settings.json`
  - Rules: R104, R105, R107 · Deep doc: see appendix
- **Auth & OAuth 2.1** — Dual auth: Bearer (Claude Code) + OAuth 2.1 (Claude.ai); staff vs client.
  - Lives in: `middleware.ts, app/api/oauth, lib/auth.ts`
  - Rules: _(none specific)_ · Deep doc: pending
- **Data model** — 164 tables (generated types are ground truth).
  - Lives in: `lib/database.types.ts`
  - Rules: _(none specific)_ · Deep doc: see appendix
- **Compliance & renewals** — RA renewal, state annual reports, deadlines, calendar sync.
  - Lives in: `lib/harbor-compliance, lib/mcp/tools/hc*/deadline*/calendar*`
  - Rules: _(none specific)_ · Deep doc: pending
- **AI agent / Antonio Brain** — Internal AI assistant / proactive intelligence.
  - Lives in: `lib/ai-agent`
  - Rules: _(none specific)_ · Deep doc: pending

## Appendix A — MCP tools (41 active groups, ~217 tools)
_Source of truth: uncommented `register*Tools` in `app/api/[transport]/route.ts`._

`Checkpoint` · `Crm` · `Drive` · `Gmail` · `Docai` · `Classify` · `Calendly` · `Doc` · `Storage` · `Sql` · `Messaging` · `Offer` · `Sysdoc` · `Knowledge` · `Circleback` · `Lead` · `Tax` · `Deadline` · `Operations` · `Whop` · `Formation` · `Onboarding` · `Lease` · `Oa` · `BankingForm` · `WelcomePackage` · `Job` · `Portal` · `ITINForm` · `Closure` · `TaxQuote` · `BankStatement` · `Signature` · `Testing` · `HarborCompliance` · `DevTask` · `Calendar` · `Referral` · `Lock` · `MemberInfo` · `Catalog`

## Appendix B — Hooks & guardrails (18 hooks)
_In `.claude/hooks/`, wired in `.claude/settings.json`; plus `.husky/pre-push` gates._

`assumption-check.sh` · `bash-production-guard.sh` · `checkpoint-counter.sh` · `post-push-qa.sh` · `pre-commit-audit.sh` · `pre-compact-save.sh` · `production-write-guard.sh` · `r093-verifier.sh` · `r095-gate.sh` · `send-guard.sh` · `session-git-pull.sh` · `stop-check.sh` · `stop-enforcement.sh` · `test-production-write-guard.sh` · `test-r095-gate.sh` · `test-send-guard.sh` · `user-prompt-contract.sh` · `verify-before-edit.sh`

**Guardrail rules (35) in CLAUDE.md:**
- **R005** — `td-operations.vercel.app` is INTERNAL: NEVER send this domain to clients
- **R012** — All client-facing URLs MUST use `APP_BASE_URL` from  — never hardcode domains; the `.husky/pre-push` hook blocks hardcod
- **R015** — NEVER remove any domain from Vercel — old links must always work.
- **R016** — All URLs, tokens, and slugs must be in English.
- **R018** — NEVER use  for CRM writes — always use .
- **R027** — `client_invoices` is for client sales invoices ONLY — TD systems NEVER write here
- **R035** — NEVER send a form to a client without testing it first via `?preview=td`.
- **R037** — All MCP send tools MUST use `safeSend()` from : idempotency check → send FIRST → status update AFTER → multi-step tracki
- **R041** — Email Subject headers MUST be RFC 2047 base64 encoded — applies to ALL email senders (API routes, cron jobs, MCP tools, 
- **R051** — Subagents must write results to Supabase BEFORE returning
- **R053** — Before INSERT on , SELECT first to check if a task on the same topic already exists
- **R060** — Master Rules KB (`370347b6`) is the CANONICAL source for business rules — wins on conflict
- **R067** — When you modify an existing file, fix any ESLint warnings in that file (lint-staged blocks the commit otherwise).
- **R070** — Run `git pull origin main` BEFORE any work, every session (enforced by SessionStart hook `session-git-pull.sh`).
- **R071** — NEVER use `git add -A` or `git add .` — stage specific files by name only
- **R076** — NEVER run `git push --force` — branch protection blocks it and it would destroy other machines' work.
- **R079** — Every UI feature MUST be tested in the browser (screenshot + interaction) before declaring it done.
- **R086** — Write unit tests for every new function in `lib/`
- **R089** — Never use Make, Zapier, n8n — all automation via Supabase Edge Functions.
- **R090** — Never commit `.env.local` or credentials.
- **R091** — Never create README.md or documentation files unless asked.
- **R092** — Client invoice emails MUST direct clients to the portal to pay (`portal.tonydurante.us` → Fatture/Invoices → Expenses)
- **R093** — NO ASSUMPTIONS
- **R094** — `leads.status='Converted'` means PAYMENT CONFIRMED (activation chain triggered), NOT offer signed
- **R096** — MCP TOOL ROUTING — TWO CONNECTIONS, CLAUDE CHOOSES (2026-05-01)
- **R097** — QB MCP tools REMOVED (2026-04-24, commit `8f9f18a`)
- **R098** — Invoice-number generator is race-safe via DB unique constraint, NOT a retry loop in code
- **R099** — Surface server errors on client-side `fetch` (2026-04-21, commit `b80ecef`)
- **R100** — Client-visible content deletion MUST use soft-delete (2026-04-21, commit `49d64df`)
- **R101** — DEVIL'S ADVOCATE MANDATORY (2026-04-21)
- **R103** — When an admin sends a portal chat message (via dashboard or `portal_chat_send` MCP tool), the client automatically recei
- **R104** — SANDBOX IS THE ONLY DEVELOPMENT ENVIRONMENT (2026-05-01, structural enforcement)
- **R105** — ALL DDL MUST GO THROUGH MIGRATION FILES (2026-04-30, structural enforcement)
- **R106** — Service/SD vocabulary lives in the catalog framework
- **R102** — Portal tier has exactly 4 values: `lead`, `formation`, `onboarding`, `active`

## Appendix C — Surface area (exact counts)
- CRM dashboard pages (41): `accounts` `addresses` `audit` `bank-feeds` `calendar` `cases` `catalog` `client-health` `clients` `config` `contacts` `dev-tools` `email-templates` `exceptions` `finance` `inbox` `intake` `invoice-aging` `invoice-settings` `leads` `owner` `partners` `payments` `pipeline` `pipeline-overview` `portal-chats` `portal-launch` `reconciliation` `referrals` `service-catalog` `services` `shared` `system-health` `tasks` `tax-returns` `team-chat` `team-management` `tools` `trackers` `workflow-issues` `workflows`
- Client portal pages (28): `activity` `apply` `auth` `billing` `change-password` `chat` `company` `customers` `deadlines` `documents` `forgot-password` `form` `guide` `invoices` `itin-documents` `login` `members` `notifications` `offer` `partner` `profile` `referrals` `reset-password` `services` `settings` `sign` `tax-documents` `wizard`
- API route groups: 62 (`app/api/*`)
- Code modules (33): `ai-agent` `audit` `billing` `calendly` `case-view` `catalog` `chat` `email` `errors` `exceptions` `finance` `forms` `harbor-compliance` `hooks` `jobs` `leads` `mcp` `notifications` `offers` `operations` `partners` `pdf` `per-record-activity` `portal` `portal-chats` `schemas` `services` `supabase` `system-health` `tasks` `tax` `types` `utils`
- Database tables: 164 (ground truth: `lib/database.types.ts`)

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

## Gaps & honesty notes
- The deep "how it works" prose for **pending** systems is NOT yet written — only the inventory above is verified. Do not treat a one-liner as a full spec.
- 3 grounded draft cards (leads, referrals, partners-team) were captured by an automated sweep and need a human-verified pass before they're trusted.
- Business rules that live only in Antonio's head (e.g. some Circleback specifics) must be captured into the knowledge base during each system's deep-doc pass.
