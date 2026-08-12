-- Sandbox-only outbound email capture (QA enablement for dev job 63fae6cb).
--
-- Sandbox blocks all outbound email (SANDBOX_MODE=1 turns every Gmail send into a
-- no-op), so a tester cannot see what a client would have received — which makes
-- the OA "re-send signing links" check unverifiable. This table records the
-- rendered content of each blocked send so staff can open and read it at
-- /sandbox-mail. It is written ONLY on the sandbox no-op path; in production that
-- branch never runs, so nothing is ever captured there.
--
-- Not client data and not a credential store in the normal sense — but the bodies
-- carry signing links, so the viewer is staff-gated and this table is service-role
-- only (no anon/authenticated grants added).

CREATE TABLE IF NOT EXISTS public.sandbox_captured_emails (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient    text,
  subject      text,
  body         text,
  links        text[],
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sandbox_captured_emails_created_at
  ON public.sandbox_captured_emails (created_at DESC);

COMMENT ON TABLE public.sandbox_captured_emails IS
  'QA-only: rendered content of outbound emails the sandbox blocked (SANDBOX_MODE). Written solely on the sandbox no-op path; inert in production. Staff-gated viewer at /sandbox-mail.';
