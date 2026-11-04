/**
 * What the service editor does after Save (flexible-offer track, "add a service from the offer").
 *
 * Saving a NEW service writes the service row first and its steps and workflow after. When a later part
 * fails, the row already exists. The editor used to stay on its "new" page, so the next Save tried to
 * create the same service again and was refused ("already exists"), leaving a half-made service and an
 * admin stuck. This decides the right next move; the page only acts on it. Pure, unit-tested.
 */

export interface SaveResultShape {
  ok: boolean
  service?: { id: string; slug: string }
  error?: string
}

export type SaveOutcome =
  | { kind: "saved"; slug: string }
  | { kind: "half_saved"; slug: string; message: string }
  | { kind: "failed"; message: string }

export function saveOutcome(result: SaveResultShape, mode: "new" | "edit"): SaveOutcome {
  if (result.ok && result.service) return { kind: "saved", slug: result.service.slug }
  const reason = result.error?.trim() || "Save failed."
  // Only a NEW service can be half-made: an existing one is already open on its own edit page.
  if (!result.ok && result.service && mode === "new") {
    return {
      kind: "half_saved",
      slug: result.service.slug,
      message: `${reason} The service itself was created and is now open for editing. Fix the problem and save again.`,
    }
  }
  return { kind: "failed", message: reason }
}
