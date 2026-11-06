/**
 * Which stage a workspace button moves the job to.
 *
 * The stage layout (catalog data, `pipeline_stages.stage_layout`) names the target of each button: Approve on "Under Review" says where
 * an approved return goes, File with IRS on "TR Completed" says "TR Filed". The button used to ignore that and move to a stage name
 * written in the component ("Review Completed", "Filed with IRS") — names the Tax Return pipeline does not have, so both buttons
 * failed with "Stage not found" (found 2026-11-05, Tax Return plan item 3). The layout now wins; the table below is only the fallback
 * for a layout that names no target, and holds REAL stages of the pipelines these buttons live in.
 *
 * Approve goes straight to "Data Received": the client's own "Confirm" step was removed (Antonio, 2026-11-06 — no client ever pressed it).
 */

export const DEFAULT_ACTION_TARGET: Record<string, string> = {
  start_review: 'Under Review',
  approve: 'Data Received',
  request_changes: 'Revision Requested',
  file_with_irs: 'TR Filed',
  mark_completed: 'Completed',
  complete: 'Closed',
}

/** The stage a button moves to: the layout's own target when it names one, else the fallback for the key, else null (no button). */
export function actionTargetStage(key: string, layoutTarget?: string | null): string | null {
  const fromLayout = typeof layoutTarget === 'string' ? layoutTarget.trim() : ''
  if (fromLayout) return fromLayout
  return DEFAULT_ACTION_TARGET[key] ?? null
}
