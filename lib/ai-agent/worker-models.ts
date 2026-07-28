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
/**
 * ⛔ NO LABEL MAY CLAIM WHICH MODEL IS "CURRENT". That drifts silently and lies.
 *
 * The old list had "Current (what it runs today)" on Sonnet 4.6 and "Newer than
 * what the worker runs today" on Sonnet 5 — but the stored setting had been moved
 * to Sonnet 5, so the menu told Antonio the opposite of the truth while the tick
 * sat on the "newer" one. Which model is running is STATE, not a label: the gear
 * shows the tick, and that is the single place it is expressed.
 *
 * Each entry describes only what is permanently true of that model.
 */
export const WORKER_MODEL_OPTIONS: WorkerModelOption[] = [
  {
    id: "claude-fable-5",
    label: "Smartest",
    hint: "The strongest reasoning available, and the least likely to guess. Thinks before answering, so it is slower and costs the most per question.",
  },
  {
    id: "claude-opus-5",
    label: "Very strong",
    hint: "Close to the smartest for most work, at roughly half the cost per question. Also thinks before answering.",
  },
  {
    id: "claude-sonnet-5",
    label: "Balanced — recommended",
    hint: "Strong reasoning at a sensible cost. The right default for everyday CRM questions and client drafts.",
  },
  {
    id: "claude-opus-4-8",
    label: "Previous top tier",
    hint: "The strongest of the older generation. Keep only if a newer one misbehaves on real conversations.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Previous balanced",
    hint: "The older everyday model. Slightly cheaper than Sonnet 5 but weaker; no reason to pick it unless rolling back.",
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
