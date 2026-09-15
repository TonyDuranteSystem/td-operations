-- Portal Chats — "Addressed to" frozen name snapshot (dev job 34bd9009)
--
-- Antonio reported that on AI Venture Labs LLC, the "Addressed to" picker
-- couldn't tell apart addressing a message to Michele Cotti personally vs.
-- addressing it to Whalecot Consulting LLC (a company he also owns and
-- represents on the same account's member roster) — both roster rows
-- resolve to the identical contact_id, so both the click/highlight and the
-- SAVED addressed_to_contact_id were indistinguishable between the two.
-- Confirmed not a one-off: a live scan found a second account (Azarexa LLC)
-- with the identical shape (Umberto Moretti / Advertising Apex LLC).
--
-- Full council review (5 reviewers, two passes) rejected the first draft
-- (a foreign key to members(id)) for two independently-found reasons:
--   1. Postgres CHECK constraints cannot reference another table, so the
--      "keep addressed_to_contact_id and this new column consistent" rule
--      the first draft wanted is not expressible as a CHECK at all.
--   2. members.id is not durable: a legacy MMLLC's member-info form
--      resubmission (submit_member_info(), see
--      20260625-1200-member-info-atomic-submit.sql) deletes and reinserts
--      every member row for the account with fresh ids — confirmed this
--      already happened once on AI Venture Labs LLC itself (2026-08-12,
--      dropping a 4th member present in the prior submission). A live FK
--      would either silently null out every historical label the next time
--      any affected account's roster is resubmitted, or — with no ON
--      DELETE clause — block the resubmission outright with an uncaught
--      foreign-key violation, breaking a client's own self-service form.
--
-- The fix instead freezes a plain, disconnected snapshot of the picked
-- roster row's own display name at send time — no foreign key, nothing to
-- keep in sync, immune to the account's roster being rebuilt later. This is
-- the same pattern portal_messages.sender_name already uses for exactly the
-- same reason (frozen at write time, preferred over a live join when
-- present). Resolved and written entirely server-side from a fresh
-- lib/portal/addressed-to.ts::resolveAccountMembersForChat() read at insert
-- time — the client sends only the roster row's id, never a name string,
-- so a stale/spoofed/arbitrary display name can never reach storage.
--
-- Deliberately NOT named addressed_to_name — that's already the API
-- response's synthesized field (join-derived historically); this is its
-- new, distinct, preferred source, not a competing column with the same
-- name.
--
-- A message addressed to a company-type member with no company_name on
-- file yet will freeze whatever name the picker already showed at the
-- time (falls back to the representative's own name — see
-- lib/portal/addressed-to.ts) — a pre-existing, narrow display gap, not
-- something this change worsens: the live picker already shows the exact
-- same ambiguity today for that rare shape.
--
-- Nullable, no backfill — only new messages get the frozen snapshot; every
-- message sent before this ships keeps rendering exactly as it does today
-- via the existing contact-name join, same precedent as
-- addressed_to_contact_id/addressed_to_company.

ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS addressed_to_label TEXT;

COMMENT ON COLUMN portal_messages.addressed_to_label IS
  'Optional (2026-09-14, dev job 34bd9009): a frozen snapshot of the addressed roster row''s own display name at send time -- e.g. "Whalecot Consulting LLC" as distinct from "Michele Cotti", when both resolve to the same addressed_to_contact_id. Resolved and written server-side ONLY, from a fresh lib/portal/addressed-to.ts::resolveAccountMembersForChat() read -- never trusted as client-supplied text. Deliberately NOT a foreign key to members(id): that table''s rows are deleted and recreated with new ids whenever a client resubmits their member-info form, which would either silently null this out or block the resubmission outright. Display/attribution metadata ONLY, same posture as addressed_to_contact_id -- never gates visibility. When present, preferred over the addressed_to_contact_id join for the staff-facing "For {name}" display; NULL for every message sent before this column existed, which fall back to that join unchanged.';
