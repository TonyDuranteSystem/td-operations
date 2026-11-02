-- Bank application intake — "we review it BEFORE it goes out" (dev job 4effa56d, Antonio 2026-11-02).
--
-- Until now the answers and documents were emailed to the link's saved addresses the moment the client pressed Submit.
-- From now on a submitted application WAITS for staff: it is marked Reviewed, then submitted to the bank contact by a
-- person pressing a button. These columns record that journey. Nothing here is read by the public submit path.
--
--   reviewed_at / reviewed_by   staff marked it "Reviewed" (all OK). Submit works only after this.
--   sent_by / sent_to           who pressed Submit and the addresses it actually went to (the setting can change later).
--   returned_at / returned_by / return_note
--                               staff SENT IT BACK to the client: the note they wrote. The old application stays on record.
--   replaces_id                 on the NEW link made by a send-back: the application it replaces.
--   staff_note                  on that new link: the message the client sees above the blank form.
--
-- Plus the two address lists, kept as ordinary app_settings rows (value = { emails, changed_by, changed_at }) so the
-- Forms page can show and change them without a deploy:
--   bofa_submit_to   where a reviewed application is submitted      (default: sekureye22@gmail.com)
--   bofa_notify_to   who is told that an application has arrived    (default: support@tonydurante.us)
--
-- Additive and re-runnable; no CHECK list on purpose (a CHECK on a shared database turns other sessions' CI red — the
-- allowed values live in lib/bofa-intake/review-state.ts). Existing rows need NO backfill: the one application already
-- emailed has email_status = 'sent', which the code treats as "submitted".
--
-- Production: Antonio runs this FIRST, then the code is merged. Sandbox: node scripts/apply-migration.js <file>.

ALTER TABLE public.bofa_intake_requests
  ADD COLUMN IF NOT EXISTS reviewed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by  text,
  ADD COLUMN IF NOT EXISTS sent_by      text,
  ADD COLUMN IF NOT EXISTS sent_to      text[],
  ADD COLUMN IF NOT EXISTS returned_at  timestamptz,
  ADD COLUMN IF NOT EXISTS returned_by  text,
  ADD COLUMN IF NOT EXISTS return_note  text,
  ADD COLUMN IF NOT EXISTS replaces_id  uuid REFERENCES public.bofa_intake_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staff_note   text;

-- At most ONE live (not revoked) replacement link per application: two staff pressing "Send back" at the same moment can
-- never leave the client with two links and two emails. A revoked replacement frees the slot (a second send-back is then allowed).
CREATE UNIQUE INDEX IF NOT EXISTS bofa_intake_one_live_replacement_idx
  ON public.bofa_intake_requests (replaces_id)
  WHERE replaces_id IS NOT NULL AND status <> 'revoked';

INSERT INTO public.app_settings (key, value, updated_at)
VALUES
  ('bofa_submit_to', jsonb_build_object('emails', jsonb_build_array('sekureye22@gmail.com'), 'changed_by', 'migration 20261102-1900', 'changed_at', now()), now()),
  ('bofa_notify_to', jsonb_build_object('emails', jsonb_build_array('support@tonydurante.us'), 'changed_by', 'migration 20261102-1900', 'changed_at', now()), now())
ON CONFLICT (key) DO NOTHING;
