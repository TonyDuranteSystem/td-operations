-- Add 'portal-nudge' to the pwa_events src channel enum (Phase 3, dev job
-- 8f38add1): the new fixed in-portal install banner links to the install page
-- with its own channel tag so its conversion is measurable separately from
-- QR/email placements. Code-side enum: INSTALL_SRC_VALUES in
-- lib/portal/install-page-mode.ts — keep the two lists identical.

ALTER TABLE pwa_events DROP CONSTRAINT pwa_events_src_check;
ALTER TABLE pwa_events ADD CONSTRAINT pwa_events_src_check CHECK (src IN (
  'qr-print', 'qr-desktop', 'email-sig', 'chat',
  'fallback-email', 'onboarding', 'campaign', 'guide',
  'portal-nudge'
));
