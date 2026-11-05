-- Left-menu layout per staff login (dev job 45aa5872, Antonio 2026-11-04: "create a new tab from the menu, move pages in and
-- out, reorder them easily" — and the layout should follow him to every computer).
--
-- ONE row per sign-in: the groups the person made and which pages sit in them. The list of real pages lives in code; this
-- only says how THIS person arranged them (shape is validated in lib/nav/menu-layout.ts before every save and again on load).
-- Who may SEE a page is never stored here — it is decided per page in code — so a saved layout can't unlock anything.
--
-- RLS on, no policies, and no direct grants to the public roles: only the server (service role) reads or writes it, through
-- /api/dashboard/menu-layout and the dashboard layout. Idempotent.

CREATE TABLE IF NOT EXISTS public.staff_menu_layouts (
  auth_user_id uuid PRIMARY KEY,
  layout       jsonb       NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.staff_menu_layouts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.staff_menu_layouts FROM anon, authenticated;

COMMENT ON TABLE public.staff_menu_layouts IS
  'Per-login left-menu layout (groups + page order) for the CRM sidebar. Server-only access (RLS on, no policies, public roles revoked). See lib/nav/menu-layout.ts.';

-- every migration that creates a table ends with the marketing lock (20261018-0110): a marketing login can never read or write this table
SELECT public.marketing_lock_all_tables();
