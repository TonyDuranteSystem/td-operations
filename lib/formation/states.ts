/**
 * Formation states — THE single source of truth (R3-1.2, dev job c0a61e44).
 *
 * Every site that validates, defaults, normalizes, or displays a formation
 * state imports from here: the offer field + Create Offer dropdown, the
 * offer-signed → pending_activations copy, formation_form_create's default,
 * the SD flow-advance resolver, and formation-materialize's validation.
 * Adding a supported state = edit this file only.
 *
 * Deliberately a CODE constant, not a catalog entry (recorded decision,
 * architect R3-1.2): the list changes ~never and call sites want the
 * compile-time literal type; a catalog entry would add a runtime fetch and a
 * second failure mode for zero flexibility gain.
 */

export const FORMATION_STATE_CODES = ["NM", "WY", "FL", "DE"] as const
export type FormationStateCode = (typeof FORMATION_STATE_CODES)[number]

export const FORMATION_STATE_NAMES: Record<FormationStateCode, string> = {
  NM: "New Mexico",
  WY: "Wyoming",
  FL: "Florida",
  DE: "Delaware",
}

/** The documented system-wide default when no capture point supplied a state. */
export const DEFAULT_FORMATION_STATE: FormationStateCode = "NM"

export function isFormationStateCode(v: unknown): v is FormationStateCode {
  return typeof v === "string" && (FORMATION_STATE_CODES as readonly string[]).includes(v)
}

/**
 * Normalize free text ("Wyoming", " wy ", "FLORIDA") to a state code, or null
 * when nothing clearly matches. Centralizes the spelling logic that used to
 * live inline in the SD flow-advance resolver (lib/service-delivery.ts).
 */
export function normalizeFormationState(raw: unknown): FormationStateCode | null {
  if (typeof raw !== "string") return null
  const t = raw.toUpperCase().trim()
  if (!t) return null
  if (isFormationStateCode(t)) return t
  if (t.includes("NEW MEXICO")) return "NM"
  if (t.includes("WYOMING")) return "WY"
  if (t.includes("FLORIDA")) return "FL"
  if (t.includes("DELAWARE")) return "DE"
  return null
}

/**
 * The wizard stores the state under one of three historical keys; read them in
 * that order and normalize. Returns null when the wizard never captured it
 * (the common case — the wizard rarely asks).
 */
export function formationStateFromWizardData(
  wd: Record<string, unknown> | null | undefined,
): FormationStateCode | null {
  if (!wd) return null
  return normalizeFormationState(
    wd.formation_state ?? wd.state_of_formation ?? wd.state_of_incorporation,
  )
}

export interface FormationStateResolution {
  code: FormationStateCode
  source: "wizard" | "submission" | "offer" | "default"
}

/**
 * Resolve the formation state from every capture point in authority order
 * (R2-B): the client's wizard answer → the formation-form/submission value →
 * the signed offer's pinned state → the documented NM default. Pure — callers
 * fetch the raw values, this decides. The admin override at Articles upload
 * (formation-materialize param) still wins above all of these, unchanged.
 */
export function resolveFormationStateCode(sources: {
  wizardState?: unknown
  submissionState?: unknown
  offerState?: unknown
}): FormationStateResolution {
  const wizard = normalizeFormationState(sources.wizardState)
  if (wizard) return { code: wizard, source: "wizard" }
  const submission = normalizeFormationState(sources.submissionState)
  if (submission) return { code: submission, source: "submission" }
  const offer = normalizeFormationState(sources.offerState)
  if (offer) return { code: offer, source: "offer" }
  return { code: DEFAULT_FORMATION_STATE, source: "default" }
}
