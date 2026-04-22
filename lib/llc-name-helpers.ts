/**
 * Pure helpers for LLC name management in the formation flow.
 *
 * Two name sources coexist:
 *   1. Client-submitted wizard names: `wizard_progress.data.llc_name_1/_2/_3`
 *      — these go through the server's legacy auto-append of " LLC" on select,
 *      for backward compatibility with inconsistent client input (some clients
 *      type the full name, some don't).
 *   2. Admin-added names: `wizard_progress.data.additional_names` array
 *      — these are stored and rendered verbatim. Staff types the full name
 *      (including any suffix) exactly as they want it on the account.
 *
 * These helpers are pure. No DB access. Easy to unit-test.
 */

export interface AdminAddedName {
  name: string
  added_at: string // ISO timestamp
  added_by?: string
}

export type NameSource = "wizard" | "admin_added"

export interface UnifiedNameOption {
  name: string
  source: NameSource
  rank?: number // 1, 2, 3 for wizard names; undefined for admin-added
  added_at?: string // for admin-added names, for ordering
}

/**
 * Merge wizard-original names and admin-added names into one ordered list.
 * Wizard names first (in rank order), then admin-added (in added_at order).
 */
export function mergeNames(
  wizardNames: { name1?: string | null; name2?: string | null; name3?: string | null },
  additionalNames: AdminAddedName[] = [],
): UnifiedNameOption[] {
  const out: UnifiedNameOption[] = []

  const w1 = (wizardNames.name1 || "").trim()
  const w2 = (wizardNames.name2 || "").trim()
  const w3 = (wizardNames.name3 || "").trim()

  if (w1) out.push({ name: w1, source: "wizard", rank: 1 })
  if (w2) out.push({ name: w2, source: "wizard", rank: 2 })
  if (w3) out.push({ name: w3, source: "wizard", rank: 3 })

  const sortedAdded = [...additionalNames].sort((a, b) =>
    (a.added_at || "").localeCompare(b.added_at || ""),
  )
  for (const entry of sortedAdded) {
    const n = (entry.name || "").trim()
    if (n) out.push({ name: n, source: "admin_added", added_at: entry.added_at })
  }

  return out
}

/**
 * Normalize a name for duplicate detection: trim + lowercase + collapse whitespace.
 * Used only for dedup — NOT for storage (storage is verbatim).
 */
export function normalizeForDedup(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Check whether a candidate name is already present in the list
 * (case-insensitive, whitespace-normalised). Use to block duplicates.
 */
export function isDuplicateName(candidate: string, existing: string[]): boolean {
  const norm = normalizeForDedup(candidate)
  if (!norm) return false
  return existing.some((n) => normalizeForDedup(n) === norm)
}

export interface NameValidationResult {
  valid: boolean
  error?: string
  trimmed?: string
}

/**
 * Validate a candidate admin-added name. Returns the trimmed value on success.
 * Rules:
 *  - must not be empty after trim
 *  - max 200 chars (DB-safe, generous for any real LLC name)
 */
export function validateAdminAddedName(raw: string): NameValidationResult {
  const trimmed = (raw || "").trim()
  if (!trimmed) return { valid: false, error: "Name cannot be empty." }
  if (trimmed.length > 200) return { valid: false, error: "Name is too long (max 200 characters)." }
  return { valid: true, trimmed }
}

/**
 * Determine whether a selected name matches an admin-added entry (verbatim)
 * or one of the wizard's three original names. Used by the server's
 * select action to decide whether to append the legacy " LLC" suffix
 * (wizard names only) or persist the name exactly as given (admin-added).
 *
 * Matching is EXACT (not case-folded) because staff types the verbatim
 * value they want on the account and any difference in casing / spacing
 * is intentional.
 */
export function classifyNameSource(
  selected: string,
  wizardNames: { name1?: string | null; name2?: string | null; name3?: string | null },
  additionalNames: AdminAddedName[] = [],
): NameSource {
  if (additionalNames.some((a) => a.name === selected)) return "admin_added"

  // Fall back to wizard origin when the name matches one of the three.
  if (selected === (wizardNames.name1 || "")) return "wizard"
  if (selected === (wizardNames.name2 || "")) return "wizard"
  if (selected === (wizardNames.name3 || "")) return "wizard"

  // Unknown origin — treat as admin_added so we preserve verbatim (safer
  // than silently appending " LLC" to a string we can't place).
  return "admin_added"
}

/**
 * Return the final company_name string that should be stored on the account,
 * per the source classification.
 *
 * Wizard names get the legacy " LLC" suffix appended if not already present
 * (kept for backward compatibility with inconsistent client input).
 * Admin-added names are stored exactly as typed.
 */
export function companyNameForAccount(selected: string, source: NameSource): string {
  const trimmed = selected.trim()
  if (source === "admin_added") return trimmed

  // Wizard path: append " LLC" if the name doesn't already end with it
  // (case-insensitive check on the suffix).
  const alreadyHasSuffix = /\bllc\b\s*$/i.test(trimmed)
  return alreadyHasSuffix ? trimmed : `${trimmed} LLC`
}
