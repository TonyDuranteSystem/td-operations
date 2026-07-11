/**
 * Dev-tracker milestones — the lifecycle a dev job climbs, now driven by a
 * STAGE SET so the stages adapt to the kind of work (a bug's stages differ from
 * a feature's). Pure (no DB) so it's unit-tested and shared by the tools, the
 * board UI, and the hooks.
 *
 * Design:
 *  - STAGE SETS: a job's stages come from a StageSet (catalog-driven, loaded
 *    server-side; DEFAULT_STAGE_SET is the fallback). Each stage declares which
 *    board lane it sits in, so the lane can be derived from any custom set.
 *  - NON-LINEAR: advanceMilestone accepts ANY stage key, forward or backward
 *    (QA fail -> building). Every move is appended to history (the trail).
 *  - ONE KNOB: the board lane (dev_task.status) is DERIVED from the current
 *    stage's lane + blocked/postponed. The advance path is the single writer.
 */

export type DevTaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled"

/** Which board lane a stage sits in. Drives the derived status. */
export type StageLane = "todo" | "in_progress" | "done"

export interface StageDef {
  key: string
  label: string
  lane: StageLane
  /** Optional settled-result field this stage displays (request/findings/plan). */
  field?: "description" | "findings" | "plan"
}

export interface StageSet {
  key: string
  label: string
  stages: StageDef[]
}

/** The standard lifecycle — fallback when a work-type has no custom set. */
export const DEFAULT_STAGE_SET: StageSet = {
  key: "default",
  label: "Standard",
  stages: [
    { key: "requested", label: "Requested", lane: "todo", field: "description" },
    { key: "investigated", label: "Investigated", lane: "in_progress", field: "findings" },
    { key: "plan_approved", label: "Plan approved", lane: "in_progress", field: "plan" },
    { key: "building", label: "Building", lane: "in_progress" },
    { key: "qa_passed", label: "QA passed", lane: "in_progress" },
    { key: "shipped", label: "Shipped", lane: "in_progress" },
    { key: "verified", label: "Verified", lane: "done" },
  ],
}

// ─── Back-compat exports (the default set, kept for existing callers/tests) ───
export const MILESTONE_STAGES = [
  "requested",
  "investigated",
  "plan_approved",
  "building",
  "qa_passed",
  "shipped",
  "verified",
] as const
export type MilestoneStage = (typeof MILESTONE_STAGES)[number]
export const MILESTONE_LABELS: Record<MilestoneStage, string> = {
  requested: "Requested",
  investigated: "Investigated",
  plan_approved: "Plan approved",
  building: "Building (sandbox)",
  qa_passed: "QA passed",
  shipped: "Shipped",
  verified: "Verified",
}
export const STAGE_FIELD: Partial<Record<MilestoneStage, "description" | "findings" | "plan">> = {
  requested: "description",
  investigated: "findings",
  plan_approved: "plan",
}
export function isMilestoneStage(v: unknown): v is MilestoneStage {
  return typeof v === "string" && (MILESTONE_STAGES as readonly string[]).includes(v)
}
export function stageOrder(stage: MilestoneStage): number {
  return MILESTONE_STAGES.indexOf(stage)
}

// ─── Stage-set helpers ───
export function stageDef(set: StageSet, key: string): StageDef | undefined {
  return set.stages.find((s) => s.key === key)
}
export function isKeyInSet(set: StageSet, key: string): boolean {
  return set.stages.some((s) => s.key === key)
}
export function labelForStage(set: StageSet, key: string): string {
  return stageDef(set, key)?.label ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── Milestones data ───
export interface MilestoneEntry {
  stage: string
  at: string // ISO timestamp
  by?: string
  note?: string
}

export interface Milestones {
  current: string
  history: MilestoneEntry[]
}

/** Seed a fresh ladder at the given start stage (default: first standard stage). */
export function initialMilestones(now: string, by?: string, startStage = "requested"): Milestones {
  return { current: startStage, history: [{ stage: startStage, at: now, by }] }
}

/**
 * Move to a target stage (forward OR backward) and append to history.
 * Returns a NEW object; does not mutate the input.
 */
export function advanceMilestone(
  prev: Milestones | null | undefined,
  to: string,
  now: string,
  by?: string,
  note?: string,
): Milestones {
  const history = Array.isArray(prev?.history) ? [...prev!.history] : []
  history.push({ stage: to, at: now, by, note })
  return { current: to, history }
}

/**
 * DEFAULT-set lane rule (back-compat; used by tests and the default path).
 *   postponed -> backlog | blocked -> blocked
 *   verified  -> done    | requested -> todo | everything else -> in_progress
 */
export function deriveStatus(
  stage: MilestoneStage,
  opts?: { blocked?: boolean; postponed?: boolean },
): DevTaskStatus {
  if (opts?.postponed) return "backlog"
  if (opts?.blocked) return "blocked"
  if (stage === "verified") return "done"
  if (stage === "requested") return "todo"
  return "in_progress"
}

/**
 * Set-aware lane rule — derive the board status from ANY stage set.
 * Overrides win; otherwise the stage's declared lane maps 1:1 onto the status.
 */
export function deriveStatusForSet(
  set: StageSet,
  currentKey: string,
  opts?: { blocked?: boolean; postponed?: boolean },
): DevTaskStatus {
  if (opts?.postponed) return "backlog"
  if (opts?.blocked) return "blocked"
  const lane = stageDef(set, currentKey)?.lane
  if (lane === "done") return "done"
  if (lane === "todo") return "todo"
  return "in_progress" // in_progress, or unknown stage → safe middle
}

/** All non-empty notes recorded when a job passed through `stage` (non-linear → may repeat). */
export function notesForStage(ms: Milestones | null | undefined, stage: string): string[] {
  if (!ms) return []
  return ms.history
    .filter((h) => h.stage === stage && typeof h.note === "string" && h.note.trim().length > 0)
    .map((h) => h.note as string)
}

/**
 * Parse a JSON/text milestones column into a typed object. LENIENT on stage
 * keys (custom stage sets use arbitrary keys); validity against a specific set
 * is a UI/tool concern (isKeyInSet), not a parse concern. Only truly malformed
 * entries (null, non-object, missing/empty stage) are dropped.
 */
export function parseMilestones(raw: unknown): Milestones | null {
  if (!raw) return null
  let obj: unknown = raw
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof obj !== "object" || obj === null) return null
  const cur = (obj as { current?: unknown }).current
  if (typeof cur !== "string" || cur.length === 0) return null
  const histRaw = (obj as { history?: unknown }).history
  const history: MilestoneEntry[] = Array.isArray(histRaw)
    ? histRaw.filter(
        (e): e is MilestoneEntry =>
          !!e &&
          typeof e === "object" &&
          typeof (e as MilestoneEntry).stage === "string" &&
          (e as MilestoneEntry).stage.length > 0,
      )
    : []
  return { current: cur, history }
}
