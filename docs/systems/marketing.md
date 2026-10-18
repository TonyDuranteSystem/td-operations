# TD Marketing (Rocco's and Ale's sales workspace)
_Last verified against code: 2026-10-17 — Claude (dev job `9aec66fa`, SANDBOX ONLY, nothing on production). **Phase P0 only: the settings storage. No screens yet.** Full plan: Drive "CRM Projects / TD MARKETING" and the same two files in CRM Storage My files (plan v1.3). First-screens drawing for approval: artifact "TD Marketing First Screens"._

## What it is
A separate, confined workspace for Rocco's sales team (Rocco = boss, Ale = his employee): leads from the ads, qualification, a paid strategic call sold with a payment link, then Antonio's upsell, with a Finance page. Today only the settings layer exists. The team record stays `draft` (nobody can log in) until Antonio switches it `active`.

## Business rules (Antonio's rulings, 2026-10-17)
- 80/20 on the strategic call is a SETTING (seller 80, TD 20), per person and per kind of sale, with an effective date. Paid to Rocco's own US LLC (Entregarse US LLC, CRM account `a2d2f660-8da9-4645-a478-54a8c1c1339d` on production).
- No price rules: any amount, any currency. No VAT or tax lines anywhere. Upsell terms are blank until Antonio sets them ("terms not set": nothing computed).
- **Rocco, as boss, has every option ON for his team, including creating offers and exporting leads** (Antonio, 2026-10-17 late); both are settings Antonio can switch off, and member-approval starts OFF. Only the commission terms, the Meta connection and the kill switch stay Antonio's. Everything else (stages, reasons, templates, permission bundles, currencies) is a stored value, never hardcoded.
- Legal/tax topics are parked (plan Appendix G) and never part of the build.

## How it's built
- Tables (migration `20261017-1900-marketing-p0-settings.sql`, undo alongside): `marketing_teams` (draft|active|paused), `marketing_settings` (key + optional team, jsonb), `marketing_settings_history` (append-only, written by a trigger on every change), `marketing_commission_terms` (append-only; shares must add to 100). RLS on, no policies: server (service role) only.
- Pure rules, client-safe: `lib/marketing/settings-schema.ts` (the setting keys, their rules and starting values; a stored value that no longer fits falls back to the default), `lib/marketing/commission.ts` (`termInForce`, `splitCents` in integer cents with the remainder to TD, `shareBase`), `lib/marketing/team-status.ts`.
- Server: `lib/marketing/settings.ts` (create team, change status, get/set settings, commission terms). Admin-only by the caller; it trusts the route to have checked.
- Payments: a Stripe checkout tagged `payment_kind` (see `docs/systems/offers.md`, job J-A) skips every client effect; the marketing ledger (P2) will read the stored webhook event. Marketing is Stripe-only because Whop carries no metadata.

## P1 — who can log in, and what they can reach (sandbox, built 2026-10-18; plan page approved by Antonio)
- Door rule: `lib/auth/role-door.ts` + `middleware.ts` (see `docs/systems/auth-oauth.md`). A `marketing` login reaches `/marketing`, the two-step pages and `/api/marketing/` only; unknown roles are turned away; marketing must pass the two-step check.
- Database: `marketing_team_members` and `marketing_invites` (migration `20261018-0110`), helper functions `marketing_my_team_ids()` / `marketing_my_owner_team_ids()` (security definer, avoid policy recursion), team-scoped READ policies; writes are server-only. Every non-marketing public table carries a RESTRICTIVE `marketing_blocked` policy.
- Decisions (Antonio): old security fix `f6ea4420` included and superseded; Rocco's workspace login is a tonydurante.us address Antonio creates (Ale and setters use their own email); address `marketing.tonydurante.us` (DNS is Antonio's step).
- **Built in P1:** the shared guard (`lib/marketing/guard.ts`, decision rules in `guard-rules.ts`: membership and team status read on EVERY request), `GET /api/marketing/me`, the `/marketing` placeholder page, permissions (`lib/marketing/permissions.ts`: the owner has every permission; a member has his bundle plus extras; a grant never exceeds the granter's own access; nobody changes his own; an optional ceiling setting, empty = none), invites (`invite-rules.ts` + `members.ts`: single-use 7-day link, only the SHA-256 of the token is stored, ONE generic answer for every acceptance failure, never touches an existing login, 20 invites per person per hour), owner routes under `/api/marketing/team/members` (list, invite, pause/resume, change access, remove = ban + token version bump), public accept page `/marketing/accept` + `/api/marketing/accept`, and Antonio's routes under `/api/marketing-admin/teams` (create team in draft, status = activation and the KILL SWITCH, owner invite).
- **Marketing logins are invisible to the client/staff tools:** `findAuthUserByEmail`, `findAuthUsersByContactId` and `findAuthUsersByEmails` (`lib/auth-admin-helpers.ts`) never return a marketing login, so clean-up, delete contact/lead/portal user, tier sync, offers, activation and password reset cannot find, rewrite or delete one by email; staff management (`/api/team-management`) neither lists nor changes nor deletes them.
- **Proof:** `scripts/marketing/qa-p1-lock.ts` (15 checks, signed tokens), `scripts/marketing/qa-p1-members.ts` (25 checks against the real database and login service), a real-browser walk-through on the private stack (owner lands on /marketing; every staff page redirects and every staff API returns 403 MARKETING_FORBIDDEN; a setter without the second step is sent to /mfa/enroll; a paused member is told so; a member removed while signed in gets 401 ACCOUNT_SUSPENDED on the next request; the invite page refuses a short password and accepts a good one). Unit: `role-door`, `marketing-permissions-guard`, `auth-admin-helpers-marketing`.
- **Not in P1 (by design):** emailing the invite (the owner/Antonio receives the one-time link; sending comes with the shared mailbox), stopping a team's outbound WhatsApp/email when the kill switch is used (there are no outbound jobs yet), the `marketing.tonydurante.us` address (Antonio's DNS step), the second-step enroll page still says "Staff accounts" (copy only).
- **Sandbox note:** three sandbox test logins have no role or the old role `staff` (`qa-e2e-pnl`, `qa-admin-test`, `qa-audit-test`); under the strict staff list they lose staff access in the shared sandbox until given `team` or `admin`. Production has none.

## Gotchas
- The shared apply script `scripts/apply-migration.js` forces SSL and fails on the private local stack ("server does not support SSL"). Apply with `docker exec -i <db container> psql -U postgres -d postgres < file.sql`.
- A rate change is a NEW term row with a later effective date. A sale will take a snapshot of the term when its payment link is created (P2), so old sales never change.
- Do not add a hardcoded stage name, reason, percentage or switch anywhere: add a key to `settings-schema.ts` instead.
- P1 (roles, middleware, login) edits protected files and needs Antonio's explicit go on the P1 plan first.

## How to verify current state
- `npx vitest run tests/unit/marketing-settings-schema.test.ts tests/unit/marketing-commission.test.ts`
- Against the private stack: `npx tsx scripts/marketing/qa-p0-settings.ts` (28 checks: draft team, defaults, history trigger, append-only terms, status flow, RLS).
- `select table_name from information_schema.tables where table_name like 'marketing_%'` returns the four tables.
