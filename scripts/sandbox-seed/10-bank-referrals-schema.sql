-- Bank referral partners (Sokin, Mercury, etc.) — banks where clients apply
-- directly via an external URL under TD's partnership. No wizard, no document
-- collection; TD just tracks whether the client clicked the apply link.
-- Apply this in BOTH sandbox (xjcxlmlpeywtwkhstjlw) and prod (ydzipybqeebtpcvsbtvs)
-- via Supabase Dashboard > SQL Editor > New Query > Paste > Run.

create table if not exists public.bank_referrals (
  slug text primary key,
  label text not null,
  apply_url text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bank_referral_clicks (
  id uuid primary key default gen_random_uuid(),
  bank_slug text not null references public.bank_referrals(slug) on delete restrict,
  account_id uuid references public.accounts(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  clicked_at timestamptz not null default now()
);

create index if not exists idx_bank_referral_clicks_account
  on public.bank_referral_clicks(account_id, bank_slug);
create index if not exists idx_bank_referral_clicks_bank
  on public.bank_referral_clicks(bank_slug);

alter table public.bank_referrals enable row level security;
alter table public.bank_referral_clicks enable row level security;

drop policy if exists "bank_referrals readable by all authed" on public.bank_referrals;
create policy "bank_referrals readable by all authed"
  on public.bank_referrals for select
  to authenticated
  using (enabled = true);

drop policy if exists "bank_referrals full to service role" on public.bank_referrals;
create policy "bank_referrals full to service role"
  on public.bank_referrals for all
  to service_role
  using (true) with check (true);

drop policy if exists "bank_referral_clicks full to service role" on public.bank_referral_clicks;
create policy "bank_referral_clicks full to service role"
  on public.bank_referral_clicks for all
  to service_role
  using (true) with check (true);
