-- Sticky notes gain a single attachment slot (Capture/Share feature, step 5).
--
-- One picture or document per note — not a gallery. Matches the stated use
-- case (share one screenshot to one note) and keeps staff_notes' existing
-- all-scalar shape (ai-architect review, 2026-09-04) rather than introducing
-- its first array/jsonb column for a "maybe someday" multi-attachment case
-- nobody asked for.
--
-- The file itself lives in the same private worker-attachments Storage
-- bucket the capture log already uses (scripts/migrations/20260904-1500-staff-captures.sql)
-- — this migration adds no new Storage surface, only a reference to what's
-- already there.
--
-- Who can attach: the note's own AUTHOR only — the exact same rule
-- (mayEditBody in lib/notes/staff-notes.ts) that already governs editing a
-- note's text, not a new permission concept (Antonio, 2026-09-04).
--
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Council reviews the real diff
-- before production.

ALTER TABLE public.staff_notes
  ADD COLUMN IF NOT EXISTS attachment_url text,
  ADD COLUMN IF NOT EXISTS attachment_name text,
  ADD COLUMN IF NOT EXISTS attachment_mime_type text,
  ADD COLUMN IF NOT EXISTS attachment_size_bytes bigint;
