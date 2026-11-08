/**
 * Company Closure — when the wizard may move the job on by itself (production end-to-end test 2026-11-07, dev job eaa4747e).
 *
 * `closure_setup` re-runs the route when a pass left a step unfinished (the safety net runs every 5 minutes). The route's move "Data Collection →
 * State Compliance Check" only checked WHERE the job was — so a retry that arrived after staff pressed "Go Back to Data Collection" pulled the job
 * forward again one second later, undoing the Go Back. The move is now written into the job's step history with the submission's token AND
 * content hash, and a retry of the SAME submission content never moves the job a second time; a real correction (new content, new hash) still
 * does, because Data Collection is the step that waits for the client.
 *
 * Two more reasons the wizard leaves the job where it is: it created the job itself, or the company the client wrote is not the one the job is
 * linked to (the package went to the person's folder and staff were told to check) — then it must not push a DIFFERENT company's job forward.
 *
 * Pure — no database.
 */

/** The note the wizard's move writes into the step history; it names the submission and (when known) the content that caused it. */
export function wizardMoveNote(token: string, contentHash: string | null | undefined): string {
  return contentHash ? `Closure wizard ${token} received [${contentHash}]` : `Closure wizard ${token} received`
}

/** True when the job's step history already holds the wizard's move for exactly this submission content. */
export function wizardAlreadyMovedJob(stageHistory: unknown, note: string): boolean {
  if (!Array.isArray(stageHistory)) return false
  return stageHistory.some((h) => !!h && typeof h === "object" && (h as { notes?: unknown }).notes === note)
}

/** `reason` is null when the job may move, else the plain sentence for the step's detail. (A flat shape: this project's TypeScript does not narrow a union on a boolean.) */
export interface WizardMoveDecision {
  move: boolean
  reason: string | null
}

/** Whether the wizard may move the job from Data Collection now. Checked in this order; the first reason that applies wins. */
export function decideWizardMove(p: {
  createdByWizard: boolean
  /** the "check this" line the destination rule produced (the client wrote another company than the one the job is linked to), or null */
  companyDisagreement: string | null
  alreadyMovedForThisContent: boolean
}): WizardMoveDecision {
  if (p.createdByWizard) return { move: false, reason: "This job was created by the wizard itself — left on Data Collection so staff check it first" }
  if (p.companyDisagreement) return { move: false, reason: "The company the client wrote is not the one this job is linked to — left on Data Collection so staff check it first (see the CHECK line)" }
  if (p.alreadyMovedForThisContent) return { move: false, reason: "The wizard already moved this job for this exact submission — a Go Back by staff is respected, not undone" }
  return { move: true, reason: null }
}
