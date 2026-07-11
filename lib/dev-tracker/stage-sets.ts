/**
 * Stage sets — the different milestone lifecycles, per kind of work. A job's set
 * is chosen by its `type` (feature/bugfix/…); each type can have its own stages.
 * Pure + client-safe: built-in sets live here; a catalog read (server-side) can
 * OVERRIDE or ADD sets, merged over these defaults. `resolveStageSet` picks the
 * set for a job.
 */
import {
  DEFAULT_STAGE_SET,
  type StageSet,
  type StageDef,
  type StageLane,
} from "./milestones"

/** A bug's lifecycle differs from a feature's — reproduce + find the cause first. */
export const BUGFIX_STAGE_SET: StageSet = {
  key: "bugfix",
  label: "Bug",
  stages: [
    { key: "reported", label: "Reported", lane: "todo", field: "description" },
    { key: "reproduced", label: "Reproduced", lane: "in_progress", field: "findings" },
    { key: "root_cause", label: "Root cause", lane: "in_progress", field: "plan" },
    { key: "fixing", label: "Fixing", lane: "in_progress" },
    { key: "qa_passed", label: "QA passed", lane: "in_progress" },
    { key: "shipped", label: "Shipped", lane: "in_progress" },
    { key: "verified", label: "Verified", lane: "done" },
  ],
}

/** Built-in sets, keyed by the job `type` they serve (+ 'default' fallback). */
export const BUILTIN_STAGE_SETS: Record<string, StageSet> = {
  default: DEFAULT_STAGE_SET,
  feature: DEFAULT_STAGE_SET,
  bugfix: BUGFIX_STAGE_SET,
}

/** Pick the stage set for a job's type, falling back to default. */
export function resolveStageSet(
  type: string | null | undefined,
  sets: Record<string, StageSet> = BUILTIN_STAGE_SETS,
): StageSet {
  return (type ? sets[type] : undefined) || sets["default"] || DEFAULT_STAGE_SET
}

/** Coerce one catalog stage-set row's metadata into a StageSet (tolerant). */
export function stageSetFromMetadata(key: string, label: string, metadata: unknown): StageSet | null {
  if (!metadata || typeof metadata !== "object") return null
  const raw = (metadata as { stages?: unknown }).stages
  if (!Array.isArray(raw)) return null
  const validLanes: StageLane[] = ["todo", "in_progress", "done"]
  const stages: StageDef[] = raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => {
      const k = typeof s.key === "string" ? s.key : ""
      const lane: StageLane = validLanes.includes(s.lane as StageLane) ? (s.lane as StageLane) : "in_progress"
      const field = (s.field === "description" || s.field === "findings" || s.field === "plan"
        ? s.field
        : undefined) as StageDef["field"]
      const def: StageDef = { key: k, label: typeof s.label === "string" ? s.label : k, lane, field }
      return def
    })
    .filter((s) => s.key.length > 0)
  if (stages.length === 0) return null
  return { key, label: label || key, stages }
}

/** Merge catalog sets over the built-ins (catalog wins on key collision). */
export function mergeStageSets(
  catalog: Record<string, StageSet>,
): Record<string, StageSet> {
  return { ...BUILTIN_STAGE_SETS, ...catalog }
}
