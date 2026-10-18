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
- Still to build in P1: the shared guard (`lib/marketing/guard.ts`), the `/marketing` placeholder page, owner-only invite/remove/pause routes, protection of clean-up/merge/tier-sync tools against marketing logins.

## Gotchas
- The shared apply script `scripts/apply-migration.js` forces SSL and fails on the private local stack ("server does not support SSL"). Apply with `docker exec -i <db container> psql -U postgres -d postgres < file.sql`.
- A rate change is a NEW term row with a later effective date. A sale will take a snapshot of the term when its payment link is created (P2), so old sales never change.
- Do not add a hardcoded stage name, reason, percentage or switch anywhere: add a key to `settings-schema.ts` instead.
- P1 (roles, middleware, login) edits protected files and needs Antonio's explicit go on the P1 plan first.

## How to verify current state
- `npx vitest run tests/unit/marketing-settings-schema.test.ts tests/unit/marketing-commission.test.ts`
- Against the private stack: `npx tsx scripts/marketing/qa-p0-settings.ts` (28 checks: draft team, defaults, history trigger, append-only terms, status flow, RLS).
- `select table_name from information_schema.tables where table_name like 'marketing_%'` returns the four tables.
