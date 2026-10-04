/**
 * Per-step settings added in N1a C2 (dev job be7da01a; plan Google Doc §20).
 *
 *   waiting_on — who must act next while a job sits on the step. Read by the Operations Calendar (C3).
 *   requires_document_to_advance — a job may not move forward past the step without a document uploaded on it;
 *     enforced by the database (trg_delivery_document_to_advance, migration 20261005-0100) for every writer.
 *
 * The values here mirror the database CHECK pipeline_stages_waiting_on_check.
 */
import { actionStageConfigFor } from "@/lib/portal/action-stage-registry"

export const WAITING_ON_VALUES = ["us", "client", "outside", "date", "none"] as const
export type WaitingOn = (typeof WAITING_ON_VALUES)[number]

/** Labels shown to staff. */
export const WAITING_ON_LABELS: Record<WaitingOn, string> = {
  us: "Us",
  client: "The client",
  outside: "An outside office (IRS, state, bank)",
  date: "A date",
  none: "Nobody: job is over",
}

export function isWaitingOn(v: unknown): v is WaitingOn {
  return typeof v === "string" && (WAITING_ON_VALUES as readonly string[]).includes(v)
}

interface StepLike {
  stage_name: string
  completes_service?: boolean | null
  waiting_on?: string | null
}

/**
 * Problems with a service's step list that a save must refuse, in plain words. Empty = fine.
 *   - more than one done step (the database also refuses it — this gives the readable message first);
 *   - a step that sends the client an "action required" message (the code registry) marked as waiting on someone
 *     other than the client — the two must never disagree.
 */
export function stepSettingsProblems(serviceType: string, steps: StepLike[]): string[] {
  const problems: string[] = []
  const done = steps.filter(s => s.completes_service === true)
  if (done.length > 1) {
    problems.push(
      `Only one step can be the "done" step — ${done.map(s => `"${s.stage_name}"`).join(" and ")} are both ticked.`,
    )
  }
  for (const s of steps) {
    if (s.waiting_on == null) continue
    if (actionStageConfigFor(serviceType, s.stage_name) && s.waiting_on !== "client") {
      problems.push(
        `"${s.stage_name}" sends the client an "action required" message, so it must be waiting on the client.`,
      )
    }
  }
  return problems
}

/**
 * The client's portal notice when a job moves to a step. When the job is closed by reaching its done step and that
 * step has its own client label (e.g. CMRA "Your office address is active"), the notice says that instead of the
 * generic "is complete!" (N1a C2). A done step without a client label keeps the generic wording.
 */
export function stageNotificationText(p: {
  serviceName: string
  isCompleted: boolean
  stageLabel: string
  hasClientLabel: boolean
}): { title: string; body: string } {
  if (p.isCompleted && p.hasClientLabel) return { title: `${p.serviceName} — ${p.stageLabel}`, body: p.stageLabel }
  if (p.isCompleted) return { title: `${p.serviceName} is complete!`, body: "Your service has been completed." }
  return { title: `${p.serviceName} update`, body: `Status updated to: ${p.stageLabel}` }
}

interface DocStepLike {
  stage_name: string
  stage_order: number
  requires_document_to_advance?: boolean | null
}

/**
 * The "needs a document" steps a move from `fromOrder` to `toOrder` would leave or jump over — the same range the
 * database rule checks (trg_delivery_document_to_advance: from <= step < to). Going back, staying, or an unknown
 * step needs nothing.
 */
export function documentStepsCrossed(
  steps: DocStepLike[],
  fromOrder: number | null | undefined,
  toOrder: number | null | undefined,
): string[] {
  if (typeof fromOrder !== "number" || typeof toOrder !== "number" || toOrder <= fromOrder) return []
  return steps
    .filter(s => s.requires_document_to_advance === true && s.stage_order >= fromOrder && s.stage_order < toOrder)
    .sort((a, b) => a.stage_order - b.stage_order)
    .map(s => s.stage_name)
}

/** The refusal shown when a step's document is missing — same words as the database rule. */
export function documentMissingMessage(stepNames: string[]): string {
  return `A document must be uploaded on "${stepNames.join(", ")}" before this job can move on.`
}
