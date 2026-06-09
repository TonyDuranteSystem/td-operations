-- onboarding-uploads bucket + RLS policies for portal wizard file uploads
-- (multi-file + resumable TUS). dev_task 64bfcdd9.
--
-- Production ALREADY has this bucket plus 'Allow public read onboarding'
-- (SELECT) and 'Allow public upload onboarding' (INSERT) policies. SANDBOX was
-- missing the bucket and ALL storage.objects policies, so wizard uploads could
-- not be QA'd there. This migration brings sandbox to parity. Idempotent.
--
-- Resumable uploads authenticate with the signed-in client's session token, so
-- the bucket needs an INSERT policy (the unique server-minted path + x-upsert:
-- false means no UPDATE policy is required — matches prod).

-- 1. Bucket (private; file_size_limit NULL = no bucket-level cap, mirrors prod).
insert into storage.buckets (id, name, public, file_size_limit)
values ('onboarding-uploads', 'onboarding-uploads', false, null)
on conflict (id) do nothing;

-- 2. Public read policy (mirrors prod 'Allow public read onboarding').
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Allow public read onboarding'
  ) then
    create policy "Allow public read onboarding"
      on storage.objects for select
      using (bucket_id = 'onboarding-uploads');
  end if;
end $$;

-- 3. Public insert policy (mirrors prod 'Allow public upload onboarding').
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Allow public upload onboarding'
  ) then
    create policy "Allow public upload onboarding"
      on storage.objects for insert
      with check (bucket_id = 'onboarding-uploads');
  end if;
end $$;
