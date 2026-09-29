-- CRM Store prerequisite (2026-09-29): the two membership-period dates the new storage's access rules read.
-- Production's `members` table does not have them yet (verified 2026-09-29); the sandbox does (same shape:
-- date, nullable, no default). They belong to the member-ownership-periods job (dev job f4c5c023, built in the
-- sandbox by another session, not shipped) — this file ONLY adds the two empty columns so the storage migrations
-- can run; it changes no data and nothing in production reads the columns until the storage is used.
-- ADD COLUMN IF NOT EXISTS: safe to run twice, and safe if that job's own migration runs later.
BEGIN;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS end_date date;
COMMIT;
