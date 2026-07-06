-- TD Communication Phase 16 — Client Landing Page Builder.
--
-- A per-CLIENT one-page landing site that Cris builds as a branding deliverable
-- and publishes to a PUBLIC path-based URL (/site/<slug>). This is distinct from
-- the Phase 9 landing editor, which edits the singleton TD Communication SERVICE
-- marketing page (one app_settings blob at /portal/td-communication). Phase 16 is
-- N sites, one per enrollment, each the client's OWN brand site.
--
-- Two schema changes:
--   1. td_comm_landing_sites — one row per client landing site (this table).
--   2. td_comm_packages.includes_landing — operator-editable flag: does this
--      package include a landing page? (Gates the builder surface.)
--
-- The landing_builder_enabled KILL-SWITCH is NOT a column — it lives in the
-- td_communication_settings app_settings blob (code-side default false, see
-- lib/td-communication/comm-settings.ts), mirroring portfolio_enabled /
-- social_kit_enabled. No DDL for it.

-- ============================================================================
-- 1. td_comm_landing_sites — per-client landing site
-- ============================================================================
-- enrollment_id NULLABLE + ON DELETE SET NULL (deliberately NOT the deliverables'
-- CASCADE): a published site has a live PUBLIC URL a client may already be
-- sharing — deleting the project must never break that URL. The published_content
-- snapshot is fully self-contained (theme + copied public logo URL), so the public
-- read never needs the enrollment row.
--
-- content vs published_content: `content` is the DRAFT the editor autosaves;
-- `published_content` is the FROZEN live snapshot (null until first publish). The
-- public page reads ONLY published_content. Publish copies content → published_content.
--
-- RLS ON / NO policy: mirrors every other td_comm_* table. The browser never
-- queries this; the API authorizes the caller (staff / scoped-partner for the
-- editor; anonymous for the public read is served by the server component via
-- supabaseAdmin after the kill-switch + published gate). Service role bypasses RLS.

create table if not exists public.td_comm_landing_sites (
  id                 uuid primary key default gen_random_uuid(),
  enrollment_id      uuid references public.td_comm_enrollments(id) on delete set null,

  -- Public routing key. <kebab>-<4hex> by default so it is not trivially
  -- enumerable and natural-name collisions are near-impossible. Globally unique.
  slug               text not null unique,

  -- Public-safe brand/business name (used for the page <title> / OG; never a
  -- private field leaks — the public projector returns only content).
  title              text not null default '',

  -- Draft working copy: { locale, theme, sections[] }. Sanitized on every write.
  content            jsonb not null default '{}'::jsonb,

  -- Frozen live snapshot; null until first publish. Re-sanitized on public read.
  published_content  jsonb,

  published          boolean not null default false,
  published_at       timestamptz,
  published_by       text,

  -- Soft-delete (R100 — client-visible content).
  deleted_at         timestamptz,
  deleted_by         text,

  created_by         text,
  created_at         timestamptz not null default now(),
  -- updated_at is the OPTIMISTIC-CONCURRENCY token: saveDraft guards on it so two
  -- editors (/collab + CRM, or two tabs) cannot silently clobber each other.
  updated_at         timestamptz not null default now()
);

-- Reverse-lookup a site from its source project (editor load). Non-unique: leaves
-- room for multiple sites per enrollment later without a schema change.
create index if not exists idx_td_comm_landing_sites_enrollment
  on public.td_comm_landing_sites (enrollment_id)
  where deleted_at is null;

-- Public read: by slug, published, non-deleted.
create index if not exists idx_td_comm_landing_sites_published
  on public.td_comm_landing_sites (slug)
  where published is true and deleted_at is null;

alter table public.td_comm_landing_sites enable row level security;
-- No policy: service-role-only access (the API authorizes the caller first),
-- identical to td_comm_enrollments / td_comm_portfolio.

-- ============================================================================
-- 2. td_comm_packages.includes_landing — does this package include a landing page?
-- ============================================================================
-- Additive, default false — no existing row/code breaks. Backfilled true for the
-- two packages whose copy promises a landing site (logo-landing, full-brand).
-- The builder section renders when the enrollment's package has this true; staff
-- keep an "enable anyway" override for manual/mis-slugged projects.

alter table public.td_comm_packages
  add column if not exists includes_landing boolean not null default false;

update public.td_comm_packages
  set includes_landing = true
  where slug in ('logo-landing', 'full-brand');
