-- Widen offers_status_check to allow 'superseded' — the value the code has
-- assumed exists since revise-offer/route.ts was built, but the live
-- constraint never actually permitted (schema/code drift, not a design
-- choice). Verified on production before writing this: exactly one offer has
-- ever been revised (christian-benavente-2026), and its ORIGINAL v1 is still
-- sitting at status='viewed' instead of 'superseded' because the UPDATE that
-- was supposed to set it has been failing on this constraint since the
-- revise-offer feature shipped — the failure was previously mistaken for a
-- generic "the offer changed mid-revision" race, because the route never
-- inspected the update's own error field (fixed alongside this migration).
--
-- 11+ call sites already read/write 'superseded' as a real status
-- (lib/offers/package-pick-status.ts, sync-offer-email.ts,
-- app/api/offers/plan-status/route.ts, pick-package/route.ts,
-- revise-offer/route.ts, the leads list + lead detail pages incl. a
-- dedicated badge color) — this migration makes the schema match what the
-- application has already been built and tested to expect, nothing more.
--
-- Confirmed via `SELECT status, count(*) FROM offers GROUP BY status` before
-- writing this: only draft/sent/viewed/signed/completed/expired are actually
-- in use today (accepted is allowed but unused) — no other value needs
-- preserving.

ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_status_check;

ALTER TABLE offers ADD CONSTRAINT offers_status_check
  CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'signed', 'completed', 'expired', 'superseded'));
