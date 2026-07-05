-- TD Communication Phase 14 — Portfolio Manager.
--
-- A curated PUBLIC showcase of completed branding work: before/after images,
-- tags/category, and a client-consent trail. Two tables:
--
--   td_comm_portfolio         — one row per showcase entry (curated by staff/Cris).
--   td_comm_showcase_consents — the audit trail of a client agreeing to be featured.
--
-- WHY a dedicated table (not the Phase 9 landing `portfolio_items` blob): Phase 9
-- is a flat 4-field list capped at 24, stored in app_settings, rendered only on the
-- login-gated portal. Phase 14 adds before/after, tags, a per-entry publish/feature
-- state, and a consent audit trail that a settings blob cannot carry. Phase 9 stays
-- untouched; this is the richer system beside it.
--
-- RLS ON / NO policy mirrors every other td_comm_* table: the browser never queries
-- these directly; the API layer authenticates the caller (staff/scoped-partner for
-- curation, the owning client for consent) and reads/writes with supabaseAdmin
-- (service role bypasses RLS). IP/user-agent on consent are read server-side, never
-- from the request body (same discipline as td_comm_disclaimers / the e-sign audit).
--
-- Images: the public `/portfolio` page is unauthenticated + cacheable, so it cannot
-- use short-lived signed URLs. before_image_url / after_image_url store PUBLIC URLs
-- (the chosen image is copied into the public `assets` bucket under portfolio/, same
-- approach as the Phase 9 landing copy). These rows are DATA, not schema — they do
-- NOT promote to prod; the curator re-creates prod entries there (the image is
-- re-copied per environment, so a full URL stays correct).

-- ============================================================================
-- 1. Showcase-consent audit trail
-- ============================================================================
-- enrollment_id is NULLABLE + ON DELETE SET NULL (deliberately NOT the disclaimer's
-- NOT NULL + CASCADE): a legal consent record must SURVIVE deletion of its project,
-- otherwise deleting an enrollment would silently erase the basis on which we
-- published a client's brand. revoked_at (nullable) = the client withdrew; a
-- withdrawal also un-publishes any linked portfolio entry (handled in app code).

create table if not exists public.td_comm_showcase_consents (
  id              uuid primary key default gen_random_uuid(),
  enrollment_id   uuid references public.td_comm_enrollments(id) on delete set null,
  contact_id      uuid,                                   -- the consenting client's contact (nullable)
  consent_version text not null,                          -- content hash of the exact consent wording shown
  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,                            -- null until the client withdraws
  ip_address      text,                                   -- read server-side, never from the body
  user_agent      text,
  method          text not null default 'click' check (method in ('click', 'docusign')),
  created_at      timestamptz not null default now()
);

-- "does THIS enrollment have a current (non-revoked) consent for THIS version?"
create index if not exists idx_td_comm_showcase_consents_enrollment
  on public.td_comm_showcase_consents (enrollment_id, consent_version);

alter table public.td_comm_showcase_consents enable row level security;
-- No policy: service-role-only access (the API authorizes the caller first),
-- identical to td_comm_disclaimers / td_comm_enrollments.

-- ============================================================================
-- 2. Portfolio entries
-- ============================================================================
-- enrollment_id NULLABLE + ON DELETE SET NULL: an entry may be tied to a real
-- project OR entered manually (older/off-system work); deleting a project never
-- deletes the showcase entry. consent_id → the opt-in row, ON DELETE SET NULL so a
-- deleted consent row never orphans/breaks the entry. consent_source records the
-- basis: a client opt-in, an admin "written permission on file" attestation, or none.

create table if not exists public.td_comm_portfolio (
  id               uuid primary key default gen_random_uuid(),
  enrollment_id    uuid references public.td_comm_enrollments(id) on delete set null,

  -- Public-facing content (bilingual title + description; client_name is a public-safe
  -- label the curator sets — may be anonymized).
  title_en         text not null default '',
  title_it         text not null default '',
  client_name      text not null default '',
  description_en   text not null default '',
  description_it   text not null default '',

  -- Images: public URLs (copied into the public `assets` bucket). "after" (the result)
  -- is required; "before" (old branding) is optional.
  before_image_url text,
  after_image_url  text not null,

  -- Taxonomy: category is free text (the filter list is derived from distinct
  -- categories on published entries — never a hardcoded dropdown); tags are
  -- language-neutral filter keys.
  category         text,
  tags             text[] not null default '{}',

  -- Curation controls.
  published        boolean not null default false,
  featured         boolean not null default false,
  sort_order       integer not null default 0,

  -- Consent basis (soft model: shown to the curator, does not block publishing;
  -- a withdrawal auto-unpublishes in app code).
  consent_source   text not null default 'none' check (consent_source in ('client_optin', 'written_on_file', 'none')),
  consent_id       uuid references public.td_comm_showcase_consents(id) on delete set null,
  attested_by      text,                                  -- set when consent_source='written_on_file'
  attested_at      timestamptz,

  -- Soft-delete (R100) — every list query filters deleted_at IS NULL.
  deleted_at       timestamptz,
  deleted_by       text,

  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Public page read: published, non-deleted, ordered.
create index if not exists idx_td_comm_portfolio_published
  on public.td_comm_portfolio (published, sort_order)
  where deleted_at is null;

-- Active (non-deleted) curator lookups, newest first.
create index if not exists idx_td_comm_portfolio_active
  on public.td_comm_portfolio (created_at desc)
  where deleted_at is null;

-- Reverse-lookup an entry from its source project (e.g. to un-publish on withdrawal).
create index if not exists idx_td_comm_portfolio_enrollment
  on public.td_comm_portfolio (enrollment_id)
  where deleted_at is null;

alter table public.td_comm_portfolio enable row level security;
-- No policy: service-role-only access (the API authorizes the caller first),
-- identical to td_comm_enrollments / td_comm_deliverables.
