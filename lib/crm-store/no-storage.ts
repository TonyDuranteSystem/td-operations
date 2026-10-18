/**
 * CRM Store — the one sentence for "this company has no storage" (Stop Drive, dev job 264bb882, slice S1c).
 *
 * Every document save now goes to the CRM storage. A company that has none (not switched, and not switchable: a closed or
 * cancelled company, the few companies decided to stay as they are, a test account) cannot receive a new file — the action
 * says so in ONE plain sentence. It is not a notice, a label or a banner: it is the answer of the action that was asked for.
 * Nothing falls back to anything else, and nothing is skipped silently.
 */

export const NO_STORAGE_SENTENCE = "This company has no document storage in the CRM, so this file could not be saved."

/** A person (not a company) with no storage: same idea, same single sentence. */
export const NO_PERSON_STORAGE_SENTENCE = "This person has no document storage in the CRM, so this file could not be saved."

/** The HTTP status for it: the request is fine, the company's state does not allow it (409 — same as a company being moved). */
export const NO_STORAGE_STATUS = 409

/** True when a save routed through `saveDocumentForAccount` / `saveDocumentForContact` did NOT land in storage. */
export function notStored(routed: { route: string }): boolean {
  return routed.route !== "store"
}
