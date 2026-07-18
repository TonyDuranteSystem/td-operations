/**
 * Worker model catalog — the models Antonio can choose from the gear on any worker
 * panel (dev job a6c3d75b, Antonio 2026-07-18: "move the option to change model
 * everywhere there is the worker with the settings icon", ONE shared setting).
 *
 * WHY A CURATED LIST, not free text: a typo'd or retired model id would break the
 * worker on EVERY surface at once, and the failure would look like "the assistant
 * is down" rather than "the setting is wrong". Choosing from known-good options
 * makes that impossible.
 *
 * WHY PLAIN LABELS: Antonio picks by what he wants (smartest / balanced / fastest),
 * not by remembering version strings. The exact id is shown underneath for when it
 * matters.
 *
 * Pure + dependency-free so both the client component and the server can import it.
 */

export interface WorkerModelOption {
  /** The provider model id actually sent to the API. */
  id: string
  /** What Antonio sees. */
  label: string
  /** One line on the trade-off, in plain English. */
  hint: string
}

/**
 * Ordered best-first. Keep this list SHORT — every extra option is a decision
 * Antonio has to make. When a newer model ships, add it here and the gear picks it
 * up everywhere; nothing else changes.
 */
export const WORKER_MODEL_OPTIONS: WorkerModelOption[] = [
  {
    id: "claude-opus-4-8",
    label: "Smartest",
    hint: "Best reasoning and least likely to guess. Costs more per question and is a little slower.",
  },
  {
    id: "claude-sonnet-5",
    label: "Balanced — recommended",
    hint: "Newer than what the worker runs today. Strong reasoning at a sensible cost.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Current (what it runs today)",
    hint: "The model in use now. Keep this until a newer one is tested against real conversations.",
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Fastest",
    hint: "Quickest and cheapest. Weakest reasoning — more likely to guess. Not for client drafts.",
  },
]

/** True when `id` is one of the options above. Anything else is rejected. */
export function isAllowedWorkerModel(id: unknown): id is string {
  return typeof id === "string" && WORKER_MODEL_OPTIONS.some((m) => m.id === id.trim())
}

/** The option record for an id, or undefined. Used to label "answered by …". */
export function workerModelOption(id: string | null | undefined): WorkerModelOption | undefined {
  const v = (id ?? "").trim()
  return WORKER_MODEL_OPTIONS.find((m) => m.id === v)
}

/** Human label for an id — falls back to the raw id so an unknown/legacy value is
 *  still visible rather than silently blank. */
export function workerModelLabel(id: string | null | undefined): string {
  const v = (id ?? "").trim()
  if (!v) return "default"
  return workerModelOption(v)?.label ?? v
}
