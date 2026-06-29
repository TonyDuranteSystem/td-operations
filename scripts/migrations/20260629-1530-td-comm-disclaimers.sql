-- TD Communication Phase 7 — Disclaimer acceptance log.
--
-- One row per time a client clicks-to-accept (or, future, DocuSigns) the brand-
-- concept disclaimer before the logo reveal. This is a LEGAL audit trail for the
-- $10,000-penalty terms: who accepted, when, from which IP/user-agent, and which
-- exact wording (disclaimer_version = a content hash of the EN+IT text the client
-- saw — see lib/td-communication/disclaimer.ts). Editing the terms changes the
-- hash, which re-gates the client on the new wording.
--
-- RLS ON / NO policy mirrors td_comm_enrollments / td_comm_deliverables: the
-- browser never queries this table directly; the API layer authenticates the
-- client (role='client', owns the enrollment) and reads/writes with supabaseAdmin
-- (service role bypasses RLS). IP/user-agent are read server-side, never trusted
-- from the request body (same discipline as the e-sign audit trail).

create table if not exists public.td_comm_disclaimers (
  id                 uuid primary key default gen_random_uuid(),
  enrollment_id      uuid not null references public.td_comm_enrollments(id) on delete cascade,
  contact_id         uuid,                                  -- the logged-in client's contact (nullable)
  disclaimer_version text not null,                         -- content hash of the accepted EN+IT text
  accepted_at        timestamptz not null default now(),
  ip_address         text,
  method             text not null default 'click' check (method in ('click', 'docusign')),
  user_agent         text,
  created_at         timestamptz not null default now()     -- row insert time (audit; matches prod)
);

-- created_at brings sandbox + this file in line with the production table (it was
-- added there at promotion time). Idempotent ADD COLUMN so re-running on any
-- environment — fresh, sandbox (created before this column existed), or prod
-- (already has it) — converges to the same 9-column shape. NOT NULL is safe: the
-- default backfills existing rows.
alter table public.td_comm_disclaimers
  add column if not exists created_at timestamptz not null default now();

-- Acceptance lookup: "has THIS enrollment accepted THIS version?" (version-keyed).
create index if not exists idx_td_comm_disclaimers_enrollment
  on public.td_comm_disclaimers (enrollment_id, disclaimer_version);

alter table public.td_comm_disclaimers enable row level security;
-- No policy: service-role-only access (the API authorizes the caller first),
-- identical to td_comm_enrollments / td_comm_deliverables / comm_conversations.
