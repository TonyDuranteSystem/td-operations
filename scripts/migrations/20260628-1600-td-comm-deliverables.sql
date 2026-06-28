-- TD Communication Phase 3 — Deliverables manager.
--
-- One row per creative deliverable (logo draft/final, landing page, brand guide,
-- business card, other) uploaded by Cris / staff against a td_comm_enrollments
-- project. Drafts carry watermark + download-block FLAGS; the client-facing
-- enforcement (watermark image + payment-gated download) is future work — this
-- table only stores the flags the future client view will consume. Release
-- gates: released_at controls client visibility; is_draft=false ("Release
-- Final") is what will unlock the high-res download after payment.
--
-- Storage: a DEDICATED PRIVATE bucket `td-comm-deliverables` (NOT the public
-- `assets` bucket the chat uses) — a public bucket would defeat the draft
-- download-block (the original would sit at a guessable public URL) and leak
-- unreleased creative work. All access is mediated by the API via service-role
-- signed URLs (the bucket has no public policy; the service role bypasses RLS —
-- same pattern as signature-requests / signed-documents). file_url stores the
-- storage PATH, signed on read.
--
-- RLS ON / NO policy mirrors td_comm_enrollments: the browser never queries this
-- table directly; the API layer authenticates (staff or td_communication-scoped
-- partner) and reads/writes with supabaseAdmin.
--
-- Soft-delete (deleted_at/deleted_by) — the DELETE route is a soft-delete (R100):
-- preserve the row + storage object for audit; the list query filters
-- deleted_at IS NULL.

create table if not exists public.td_comm_deliverables (
  id                uuid primary key default gen_random_uuid(),
  enrollment_id     uuid not null references public.td_comm_enrollments(id) on delete cascade,
  type              text not null check (type in (
                      'logo_draft', 'logo_final', 'landing_page',
                      'brand_guide', 'business_card', 'other')),
  file_url          text,                       -- storage path (private bucket) or public URL
  drive_file_id     text,                       -- optional Google Drive file id (future mirror)
  file_name         text not null,
  file_size         integer,
  mime_type         text,
  is_draft          boolean not null default true,   -- controls watermark + download block (client-side, future)
  concept_number    integer not null default 1,      -- A / B / C concepts
  version_number    integer not null default 1,      -- v1 / v2 / v3 revisions
  watermark_applied boolean not null default false,
  released_at       timestamptz,                -- null until the client can see it
  released_by       text,
  deleted_at        timestamptz,                -- soft-delete (R100)
  deleted_by        text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_td_comm_deliverables_enrollment_type
  on public.td_comm_deliverables (enrollment_id, type);

create index if not exists idx_td_comm_deliverables_enrollment_concept
  on public.td_comm_deliverables (enrollment_id, concept_number);

-- Active (non-deleted) lookups, newest first.
create index if not exists idx_td_comm_deliverables_active
  on public.td_comm_deliverables (enrollment_id, created_at desc)
  where deleted_at is null;

alter table public.td_comm_deliverables enable row level security;
-- No policy: service-role-only access (the API authorizes the caller first),
-- identical to td_comm_enrollments / comm_conversations.

-- Dedicated PRIVATE storage bucket. 100 MB cap mirrors the chat `assets` bucket
-- (CHAT_ATTACHMENT_MAX_MB). No public read/insert policy — the API mints signed
-- upload + download URLs with the service role (bypasses RLS).
insert into storage.buckets (id, name, public, file_size_limit)
values ('td-comm-deliverables', 'td-comm-deliverables', false, 104857600)
on conflict (id) do nothing;
