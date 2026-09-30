-- CRM Store — File Understanding (2026-09-30, job 685467b5, Part 15 "AI Document Check"). Sandbox first (R105). Idempotent.
--   · store_file_analysis  — ONE row per (file version, analyzer version): what was read from the file and what the AI
--                            concluded. The unique key is the duplicate-job / double-spend guard (the job queue has none).
--                            Old analyzer versions are kept (never overwritten) so results stay comparable.
--   · store_ai_calls       — audit row for every call to the AI provider: WHAT was sent (counts), never the content.
--   · store_ai_examples    — staff corrections/confirmations the AI is shown next time (type + name pattern + folder kind
--                            ONLY — never another client's names, numbers or text). Revocable.
--   · store_ai_decisions   — what staff did with each suggestion (feeds the scoreboard: accepted unchanged / changed / dismissed).
--   · store_file_links     — "these two files are the same document" across owners: a LINK, never a delete.
-- No CHECK value lists on purpose: the allowed values live in code (lib/crm-store/understand/vocab.ts) so they stay flexible.
BEGIN;

CREATE TABLE IF NOT EXISTS public.store_file_analysis (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id       uuid NOT NULL REFERENCES public.store_file_versions(id) ON DELETE RESTRICT,
  file_id          uuid NOT NULL REFERENCES public.store_files(id) ON DELETE RESTRICT,
  analyzer_version text NOT NULL,
  status           text NOT NULL,                 -- read | partial | unreadable | failed | judged
  kind             text,                          -- pdf | image | heic | text | csv | xlsx | docx | zip | unknown …
  page_count       integer,
  pages_read       integer,
  word_count       integer,
  norm_sha256      text,                          -- hash of the normalised words (same words, different bytes)
  identity_class   boolean NOT NULL DEFAULT false,-- passport / ID class: its text is NOT copied into the searchable ocr_text
  problem          text,
  ai_type          text,                          -- a storage_document_types slug (validated in code)
  ai_name          text,
  ai_reason        text,
  ai_company       text,
  ai_year          integer,
  verdict          text,                          -- green | red (never decided by the AI's own confidence)
  red_reasons      jsonb NOT NULL DEFAULT '[]'::jsonb,
  crm_check        text,                          -- pass | fail | none
  example_check    text,                          -- pass | fail | none
  duplicate_of     uuid REFERENCES public.store_files(id) ON DELETE SET NULL,
  duplicate_kind   text,                          -- same_bytes | same_words | different_words
  duplicate_diff   jsonb,
  model            text,
  input_tokens     integer,
  output_tokens    integer,
  cost_usd         numeric(10,5),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_file_analysis_version_uq UNIQUE (version_id, analyzer_version)
);
CREATE INDEX IF NOT EXISTS store_file_analysis_file_idx ON public.store_file_analysis (file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS store_file_analysis_verdict_idx ON public.store_file_analysis (verdict) WHERE verdict IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.store_ai_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id   uuid REFERENCES public.store_file_analysis(id) ON DELETE SET NULL,
  version_id    uuid REFERENCES public.store_file_versions(id) ON DELETE SET NULL,
  purpose       text NOT NULL,                    -- classify | compare
  provider      text NOT NULL,
  model         text NOT NULL,
  key_surface   text NOT NULL,                    -- which key (WORKER_KEY_<surface>) — never the key
  pages_sent    integer,
  bytes_sent    bigint,
  input_tokens  integer,
  output_tokens integer,
  cost_usd      numeric(10,5),
  status        text NOT NULL,                    -- ok | error | refused
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_ai_calls_day_idx ON public.store_ai_calls (created_at DESC);

CREATE TABLE IF NOT EXISTS public.store_ai_examples (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id      uuid REFERENCES public.store_files(id) ON DELETE SET NULL,
  version_id   uuid REFERENCES public.store_file_versions(id) ON DELETE SET NULL,
  type_slug    text NOT NULL,
  name_pattern text,
  folder_kind  text,
  origin       text NOT NULL,                     -- correction | confirmed
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  retracted_at timestamptz,
  retracted_by uuid
);
CREATE INDEX IF NOT EXISTS store_ai_examples_type_idx ON public.store_ai_examples (type_slug) WHERE retracted_at IS NULL;
-- one live example per file version and type (a re-confirm does not double-count)
CREATE UNIQUE INDEX IF NOT EXISTS store_ai_examples_version_type_uq ON public.store_ai_examples (version_id, type_slug) WHERE retracted_at IS NULL AND version_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.store_ai_decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES public.store_file_analysis(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES public.store_files(id) ON DELETE CASCADE,
  action      text NOT NULL,                      -- applied | changed | dismissed | linked | moved
  before_state jsonb,
  after_state  jsonb,
  actor       uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_ai_decisions_analysis_idx ON public.store_ai_decisions (analysis_id);

CREATE TABLE IF NOT EXISTS public.store_file_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       uuid NOT NULL REFERENCES public.store_files(id) ON DELETE CASCADE,
  other_file_id uuid NOT NULL REFERENCES public.store_files(id) ON DELETE CASCADE,
  kind          text NOT NULL,                    -- same_bytes | same_words
  note          text,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_file_links_pair_uq UNIQUE (file_id, other_file_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['store_file_analysis','store_ai_calls','store_ai_examples','store_ai_decisions','store_file_links']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, PUBLIC', t);
  END LOOP;
END $$;

COMMIT;
