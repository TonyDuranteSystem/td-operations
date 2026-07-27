-- Bank Applications page becomes CRM-editable (dev_task d1ac4a3e).
--
-- The client-facing /portal/banks "Bank Applications" page was a hardcoded
-- array (Relay, Payset, Mercury, Sokin, Wise) while bank_referrals fed a
-- separate, smaller "Partner Banks" box on the portal home. Two lists, two
-- places to edit, and the hardcoded Sokin tile pointed at an UNTAGGED
-- sokin.com so its clicks were never attributed to TD.
--
-- This migration gives bank_referrals the fields the page renders, so the CRM
-- screen (Trackers -> Banking Fintech) becomes the single source of truth and
-- Antonio can add/remove/reorder banks without a code change.
--
-- rep_email exists in PRODUCTION but was missing from sandbox (verified
-- 2026-07-27 via information_schema on both refs) — added here so the two
-- environments finally match.

alter table public.bank_referrals
  add column if not exists rep_email      text,
  add column if not exists tag            text,
  add column if not exists description_en text,
  add column if not exists description_it text,
  add column if not exists managed        boolean not null default false,
  add column if not exists sort_order     integer not null default 100;

comment on column public.bank_referrals.tag is
  'Short currency/positioning label shown on the tile, e.g. "USD" or "Multi-currency".';
comment on column public.bank_referrals.managed is
  'TRUE = TD collects the details and files the application for the client. The tile opens the internal intake form (apply_url is an internal /portal/... path) in the SAME tab and is NOT click-tracked. FALSE = self-service; apply_url is the provider''s external http(s) link and the tile routes through /portal/apply/bank/<slug> so the click is recorded.';
comment on column public.bank_referrals.sort_order is
  'Tile display order, ascending. Managed banks lead (Relay 10, Payset 20).';

-- Seed / refresh the curated list. Wise is deliberately absent (Antonio,
-- 2026-07-27). Relay + Payset keep the managed "we file it for you" flow.
-- Descriptions are starting text only — Antonio edits them from the CRM.
insert into public.bank_referrals
  (slug, label, apply_url, tag, managed, sort_order, description_en, description_it, enabled)
values
  ('relay', 'Relay', '/portal/wizard?type=banking_relay', 'USD', true, 10,
   'US business account (USD) — fill in your details and we prepare and submit the application for you.',
   'Conto business USA (USD) — inserisci i tuoi dati e prepariamo e inviamo la richiesta per te.', true),
  ('payset', 'Payset', '/portal/wizard?type=banking_payset', 'EUR / Multi-currency', true, 20,
   'EUR/IBAN multi-currency account — fill in your details and we submit the application for you.',
   'Conto multivaluta EUR/IBAN — inserisci i tuoi dati e inviamo la richiesta per te.', true),
  ('mercury', 'Mercury', 'https://mercury.com/', 'USD', false, 30,
   'US banking popular with startups and e-commerce — fast online application.',
   'Banca USA molto usata da startup ed e-commerce — domanda online veloce.', true),
  ('sokin', 'Sokin', 'https://www.sokin.com?pid=tonydurantellc', 'Multi-currency', false, 40,
   'Multi-currency account for international payments and transfers.',
   'Conto multivaluta per pagamenti e bonifici internazionali.', true),
  ('revolut', 'Revolut', 'https://business.revolut.com/signup?promo=referabusiness&ext=f1ddcb7d-7359-471f-ae95-6fc51004e13f&context=B2B_REFERRAL', 'Multi-currency', false, 50,
   'Business account with multi-currency balances and international transfers.',
   'Conto business multivaluta con bonifici internazionali.', true),
  ('airwallex', 'Airwallex', 'https://partners.airwallex.com/149l8vgnmr5o', 'Multi-currency', false, 60,
   'Multi-currency business account for global payments and collections.',
   'Conto business multivaluta per incassi e pagamenti internazionali.', true),
  ('verto', 'Verto', 'https://platform043033.typeform.com/to/LCVzVO9f', 'Multi-currency', false, 70,
   'Multi-currency business account — apply through the partner application form.',
   'Conto business multivaluta — candidati tramite il modulo del partner.', true)
on conflict (slug) do update set
  label          = excluded.label,
  apply_url      = excluded.apply_url,
  tag            = excluded.tag,
  managed        = excluded.managed,
  sort_order     = excluded.sort_order,
  description_en = excluded.description_en,
  description_it = excluded.description_it,
  enabled        = excluded.enabled,
  updated_at     = now();

-- Wise: never seeded here. If a 'wise' row exists in any environment (it does
-- not in prod or sandbox as of 2026-07-27), disable rather than delete so any
-- click history survives for reporting.
update public.bank_referrals set enabled = false, updated_at = now() where slug = 'wise';
