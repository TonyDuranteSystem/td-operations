-- Smart Categorization v2, Phase 0.5 (2026-07-03): queryable AI-run record.
-- Architect mandate: today the AI pass's outcome is a step-detail STRING inside
-- job_queue.result — not queryable, not trendable, useless for calibration.
-- One row per AI pass (workspace or client path): what ran, with which prompt
-- version, how many batches/suggestions/applies, truncations, errors.
-- This is the data source for precision trending + the Phase 1 eval reports.

CREATE TABLE IF NOT EXISTS public.ai_categorization_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one of the two scopes is set (workspace pass vs client pass).
  workspace_id uuid REFERENCES public.pnl_workspaces(id) ON DELETE SET NULL,
  account_id uuid,
  tax_year int,
  model text NOT NULL,
  prompt_version text NOT NULL,
  batches_sent int NOT NULL DEFAULT 0,
  batches_failed int NOT NULL DEFAULT 0,
  truncated_batches int NOT NULL DEFAULT 0,
  suggestions_parsed int NOT NULL DEFAULT 0,
  applied int NOT NULL DEFAULT 0,
  labeled int NOT NULL DEFAULT 0,
  uncategorized_remaining int,
  capped boolean NOT NULL DEFAULT false,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_categorization_runs ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only, same posture as pnl_workspaces.

CREATE INDEX IF NOT EXISTS idx_ai_runs_workspace ON public.ai_categorization_runs (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_runs_account_year ON public.ai_categorization_runs (account_id, tax_year) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_runs_created ON public.ai_categorization_runs (created_at DESC);
