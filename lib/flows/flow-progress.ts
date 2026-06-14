/**
 * Flow progress — pure stage-position logic for the client portal "Service
 * Status" section (Service Flow Workspaces, client side).
 *
 * Given a flow's catalog stages (pipeline_stages for one service_type) and the
 * SD's current stage NAME, compute a client-facing progress fraction and the
 * current stage's client label.
 *
 * Membership rule mirrors the Tax tracker (lib/tax/progress-tracker.ts):
 * the client-facing journey = stages with a non-null `client_label`. Internal
 * stages (no client_label, e.g. CMRA's "Lease Created") are not part of the
 * visible journey. A flow whose stages carry NO client_label at all yields
 * `totalStages = 0` so the caller can render a neutral "Active" state with no
 * progress bar instead of an empty/0-of-0 bar.
 *
 * Never throws and never returns null — an unknown/legacy current-stage name
 * just yields `completedStages = 0` (nothing highlighted yet), matching the
 * tracker's defensive "don't guess" stance without hiding the whole flow.
 */

export interface FlowStageRow {
  stage_name: string
  stage_order: number
  client_label: string | null
  client_label_it: string | null
  icon?: string | null
}

export interface FlowStep {
  /** Catalog stage_name (internal key). */
  stageName: string
  /** Locale-resolved client-facing label. */
  label: string
  /** Optional catalog icon (emoji/char), or null. */
  icon: string | null
  state: 'completed' | 'current' | 'future'
}

export interface FlowProgress {
  /** Number of client-facing stages reached (1-based count, 0 if not started). */
  completedStages: number
  /** Total client-facing stages in this flow (0 when the flow has none). */
  totalStages: number
  /** Locale-resolved label of the current client-facing stage, or null. */
  currentLabel: string | null
}

/** Resolve a stage's display label for the requested locale, IT falling back
 *  to EN, then null. */
function labelFor(stage: FlowStageRow, locale: 'en' | 'it'): string | null {
  if (locale === 'it') return stage.client_label_it ?? stage.client_label ?? null
  return stage.client_label ?? null
}

export function computeFlowProgress(
  stages: FlowStageRow[],
  currentStageName: string | null,
  locale: 'en' | 'it',
): FlowProgress {
  const labelled = stages
    .filter(s => s.client_label !== null)
    .sort((a, b) => a.stage_order - b.stage_order)

  const totalStages = labelled.length
  if (totalStages === 0) {
    return { completedStages: 0, totalStages: 0, currentLabel: null }
  }

  // Resolve the SD's current stage order from the FULL stage list (the current
  // stage may itself be an internal, unlabelled stage that sits between two
  // labelled ones — we still want to highlight the previous labelled step).
  const current = currentStageName
    ? stages.find(s => s.stage_name === currentStageName) ?? null
    : null
  if (!current) {
    return { completedStages: 0, totalStages, currentLabel: null }
  }

  // Highest labelled stage at or below the current order = the active step.
  let currentIdx = -1
  for (let i = 0; i < labelled.length; i++) {
    if (labelled[i].stage_order <= current.stage_order) currentIdx = i
  }

  if (currentIdx === -1) {
    // Before the first labelled stage — journey not visibly started yet.
    return { completedStages: 0, totalStages, currentLabel: null }
  }

  return {
    completedStages: currentIdx + 1,
    totalStages,
    currentLabel: labelFor(labelled[currentIdx], locale),
  }
}

/**
 * Build the full ordered step list for a flow's visual progress stepper, or
 * null when the flow has no client-facing stages (CMRA) — the caller then
 * renders a neutral "Active" state instead of an empty stepper.
 *
 * Each labelled stage becomes a step marked completed / current / future. The
 * "current" step is the highest labelled stage at or below the SD's current
 * stage order (so an internal in-between stage keeps the previous labelled step
 * highlighted). When the current stage is unknown/legacy or sits before the
 * first labelled stage, no step is marked current — every step is "future"
 * (journey not visibly started), which still shows the client the road ahead.
 */
export function buildFlowSteps(
  stages: FlowStageRow[],
  currentStageName: string | null,
  locale: 'en' | 'it',
): FlowStep[] | null {
  const labelled = stages
    .filter(s => s.client_label !== null)
    .sort((a, b) => a.stage_order - b.stage_order)

  if (labelled.length === 0) return null

  const current = currentStageName
    ? stages.find(s => s.stage_name === currentStageName) ?? null
    : null

  let currentIdx = -1
  if (current) {
    for (let i = 0; i < labelled.length; i++) {
      if (labelled[i].stage_order <= current.stage_order) currentIdx = i
    }
  }

  return labelled.map((s, i) => ({
    stageName: s.stage_name,
    label: labelFor(s, locale) ?? s.stage_name,
    icon: s.icon ?? null,
    state:
      currentIdx === -1
        ? 'future'
        : i < currentIdx
          ? 'completed'
          : i === currentIdx
            ? 'current'
            : 'future',
  }))
}
