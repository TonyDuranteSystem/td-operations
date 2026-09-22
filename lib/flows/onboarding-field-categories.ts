/**
 * Splits an onboarding submission's flat field dict into CLIENT (the owner,
 * as a person) vs COMPANY (the LLC itself) sections for the Onboarding
 * Workspace — Antonio, 2026-09-22, explicit numbered spec: "1. the
 * information for the client with the documents, 2. the information about
 * the company with the document". Pure, unit-testable; no I/O.
 */

const CLIENT_PREFIXES = ["owner_", "personal_"]
const CLIENT_BARE_FIELDS = new Set(["first_name", "last_name", "email", "phone", "disclaimer_accepted"])
const CLIENT_DOC_PREFIXES = ["passport"]

/** A field whose VALUE is a storage path (not real answer data) — the
 *  wizard stores the uploaded file's own path under the same key as the
 *  document type (e.g. `passport_owner: "onboarding/<offer>/passport_owner_..."`).
 *  These are already rendered as clickable document links; showing the raw
 *  path a second time in the plain-text field grid just overflows the page
 *  with an unreadable string (found live, Antonio 2026-09-22). */
export function isStoragePathValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("onboarding/")
}

export interface CategorizedFields {
  client: [string, unknown][]
  company: [string, unknown][]
}

export function categorizeSubmittedFields(
  submittedData: Record<string, unknown>,
): CategorizedFields {
  const client: [string, unknown][] = []
  const company: [string, unknown][] = []
  for (const [key, value] of Object.entries(submittedData)) {
    if (key === "additional_members") continue
    if (isStoragePathValue(value)) continue
    const isClient = CLIENT_PREFIXES.some((p) => key.startsWith(p)) || CLIENT_BARE_FIELDS.has(key)
    ;(isClient ? client : company).push([key, value])
  }
  return { client, company }
}

export function isClientDocument(filePath: string): boolean {
  const fileName = filePath.split("/").pop() ?? filePath
  return CLIENT_DOC_PREFIXES.some((p) => fileName.startsWith(p))
}
