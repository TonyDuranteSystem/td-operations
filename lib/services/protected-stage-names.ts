/**
 * Stage names the CODE depends on, and therefore cannot be renamed from the
 * Service Catalog editor.
 *
 * A stage name is normally just a label. But in a number of places the code
 * matches one literally to decide a real client outcome, so renaming the stage
 * in the editor leaves that code looking for a name nothing has any more — and
 * the failure is silent. The worst example: whether a paying tax client's
 * wizard opens is decided by an exact match on "Wizard Available", and that
 * check fails CLOSED. Rename the stage and every one of those clients loses
 * access with no error anywhere.
 *
 * The proper fix is to give every stage a permanent internal key and let the
 * visible name be free text. That is a refactor across 17 files, several of them
 * on money paths. Until then this list is the honest middle: a rename is allowed
 * for every stage the code does NOT name, and refused with an explanation for
 * the ones it does.
 *
 * KEEPING IT HONEST: `tests/unit/protected-stage-names.test.ts` scans the
 * codebase for stage-name comparisons and fails if it finds a literal that is
 * not declared here. Add a new hardcoded stage name and the test tells you to
 * declare it — the list cannot silently fall behind the code.
 */

/** Why a given name is pinned, shown to the admin when a rename is refused. */
export interface ProtectedStageName {
  name: string
  /** Plain-English consequence of renaming it. */
  because: string
}

export const PROTECTED_STAGE_NAMES: ProtectedStageName[] = [
  {
    name: "Wizard Available",
    because: "it decides whether a paying tax client's wizard opens, and it fails closed",
  },
  {
    name: "Payment Received",
    because: "it decides whether a one-time tax client's wizard opens",
  },
  {
    name: "Company Data Pending",
    because: "the tax intake checks for it before asking a client for company details",
  },
  {
    name: "SS-4 Prepared",
    because: "the alert that warns you an SS-4 has sat unsent is matched on it",
  },
  {
    name: "Client Signing",
    because: "it is how a client's ITIN documents are found and shown in the portal",
  },
  {
    name: "Data Collection",
    because: "form completion routes move deliveries off it by name",
  },
  {
    name: "Data Received",
    because: "the tax review flow matches it when a submission is confirmed",
  },
  { name: "Data Submitted", because: "the tax board groups deliveries by it" },
  { name: "Articles Received", because: "the formation flow advances through it by name" },
  { name: "Sent for Signature", because: "the signature flow matches it by name" },
  { name: "Sent to be filed", because: "the tax filing flow matches it by name" },
  { name: "TR Filed", because: "the tax filing flow matches it by name" },
  { name: "Extension Requested", because: "the extension flow matches it by name" },
  { name: "Extension Filed", because: "the extension flow matches it by name" },
  { name: "Lease Created", because: "the lease flow matches it by name" },
  { name: "Closing", because: "the closure flow matches it by name" },
  { name: "Closed", because: "the closure flow matches it by name" },
  { name: "Completed", because: "completion is detected by this name" },
  {
    name: "Awaiting 2nd Payment",
    because: "the second-installment invoice is only offered to a client sitting on it",
  },
]

const BY_NAME = new Map(PROTECTED_STAGE_NAMES.map(p => [p.name.toLowerCase(), p]))

/** The reason this name is pinned, or null when it is free to rename. */
export function protectedStageReason(stageName: string): string | null {
  return BY_NAME.get(stageName.trim().toLowerCase())?.because ?? null
}
