-- TD Communication — Phase 8 (CRM admin panel)
-- New operator-managed vocabulary tables: packages clients can buy + the
-- brand-audit questions. Both are catalog-style config edited from the CRM
-- admin tabs (admin-only writes). Mirrors the td_comm_* convention:
-- RLS ON with NO policy → service-role-only access after an explicit API
-- auth check (an anon/authenticated query returns zero rows).
--
-- Sandbox-first (R105). Apply: node scripts/apply-migration.js <file>
-- Do NOT promote to production without Antonio's explicit approval.

-- ─────────────────────────────────────────────────────────────────────────
-- td_comm_packages — the purchasable branding packages
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.td_comm_packages (
  slug            text PRIMARY KEY,
  name_en         text NOT NULL,
  name_it         text,
  description_en  text,
  description_it  text,
  price_usd       numeric,
  delivery_days   integer,
  max_revisions   integer NOT NULL DEFAULT 2,
  payment_timing  text NOT NULL DEFAULT 'on_approval'
                    CHECK (payment_timing IN ('upfront', 'on_approval')),
  highlighted     boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  includes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  upsell_from     text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.td_comm_packages ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS td_comm_packages_active_sort_idx
  ON public.td_comm_packages (active, sort_order);

-- Seed the 3 default packages. Slugs align with PACKAGE_LABELS in
-- lib/td-communication/pipeline.ts so existing board cards stay labeled.
INSERT INTO public.td_comm_packages
  (slug, name_en, name_it, description_en, description_it, price_usd,
   delivery_days, max_revisions, payment_timing, highlighted, sort_order, includes)
VALUES
  ('logo', 'Logo Only', 'Solo Logo',
   'A professional, custom logo for your brand.',
   'Un logo professionale e personalizzato per il tuo brand.',
   500, 2, 2, 'on_approval', false, 0,
   '["Custom logo design", "2 initial concepts", "Final files (PNG, SVG, PDF)"]'::jsonb),
  ('logo-landing', 'Logo + Landing Page', 'Logo + Landing Page',
   'A custom logo plus a single-page landing site to launch your brand online.',
   'Un logo personalizzato piu una landing page per lanciare il tuo brand online.',
   1000, 5, 2, 'on_approval', true, 1,
   '["Everything in Logo Only", "One-page landing site", "Mobile-responsive design"]'::jsonb),
  ('full-brand', 'Full Brand Identity', 'Identita di Marca Completa',
   'A complete brand identity: logo, color system, typography, and brand guidelines.',
   'Un''identita di marca completa: logo, sistema di colori, tipografia e linee guida.',
   2000, 10, 2, 'on_approval', false, 2,
   '["Everything in Logo + Landing Page", "Color & typography system", "Brand guidelines document", "Business card design"]'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- td_comm_questions — the brand-audit wizard questions (operator-editable)
-- key = the form_data key written by a future client enrollment wizard and
-- consumed by groupBrief() in lib/td-communication/pipeline.ts.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.td_comm_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  label_en    text NOT NULL,
  label_it    text,
  type        text NOT NULL DEFAULT 'text'
                CHECK (type IN ('text', 'textarea', 'select', 'number', 'file')),
  required    boolean NOT NULL DEFAULT false,
  step        integer NOT NULL DEFAULT 1,
  audience    text NOT NULL DEFAULT 'both'
                CHECK (audience IN ('new_brand', 'rebrand', 'both')),
  options     jsonb NOT NULL DEFAULT '[]'::jsonb,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.td_comm_questions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS td_comm_questions_active_step_sort_idx
  ON public.td_comm_questions (active, step, sort_order);

-- Seed the current implicit brand-brief fields (the groupBrief keys), so the
-- Questions tab opens populated. All 'both' to start; admin can re-scope.
INSERT INTO public.td_comm_questions
  (key, label_en, label_it, type, required, step, audience, sort_order)
VALUES
  ('business_name',        'Business name',            'Nome dell''attivita',        'text',     true,  1, 'both', 0),
  ('business_description', 'Describe your business',   'Descrivi la tua attivita',   'textarea', true,  1, 'both', 1),
  ('industry',             'Industry',                 'Settore',                    'text',     false, 1, 'both', 2),
  ('target_audience',      'Who is your target audience?', 'Chi e il tuo pubblico?', 'textarea', true,  2, 'both', 0),
  ('audience_age',         'Audience age range',       'Fascia di eta del pubblico', 'text',     false, 2, 'both', 1),
  ('audience_location',    'Audience location',        'Localizzazione del pubblico','text',     false, 2, 'both', 2),
  ('style_preferences',    'Style preferences',        'Preferenze di stile',        'textarea', false, 3, 'both', 0),
  ('style_keywords',       'Style keywords',           'Parole chiave di stile',     'text',     false, 3, 'both', 1),
  ('brands_admired',       'Brands you admire',        'Brand che ammiri',           'text',     false, 3, 'both', 2),
  ('color_choices',        'Preferred colors',         'Colori preferiti',           'text',     false, 4, 'both', 0),
  ('color_notes',          'Color notes',              'Note sui colori',            'textarea', false, 4, 'both', 1),
  ('colors_to_avoid',      'Colors to avoid',          'Colori da evitare',          'text',     false, 4, 'both', 2),
  ('additional_notes',     'Additional notes',         'Note aggiuntive',            'textarea', false, 5, 'both', 0),
  ('timeline',             'Desired timeline',         'Tempistica desiderata',      'text',     false, 5, 'both', 1),
  ('budget',               'Budget',                   'Budget',                     'text',     false, 5, 'both', 2)
ON CONFLICT (key) DO NOTHING;
