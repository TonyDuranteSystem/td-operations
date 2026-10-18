/**
 * "Is there a storage place for this?" — asked BEFORE a tool generates anything, so a document is never made, claimed as
 * saved, and then lost (Stop Drive S1b, dev job 264bb882). Nothing can be written to Drive any more, so a company or person
 * without a CRM storage place gets ONE plain refusal up front.
 *
 * - company: has a place when its files live in the storage (or a formation case holds it). A company still on the old
 *   Drive has none and one is NOT invented here (that would be a move of its files, a deliberate act).
 * - person: has a place when they have their own storage; otherwise it is created now (same call the save path uses).
 */

export interface StoragePlaceDeps {
  companyState: (accountId: string) => Promise<"switched" | "drive" | "moving" | string>
  liveOwnerOfContact: (contactId: string) => Promise<string | null>
  ensurePersonOwner: (contactId: string, name: string) => Promise<string>
}

/** message is empty when ok (a flat shape: this repo's tsconfig is not strict, so a union would not narrow) */
export interface StoragePlace { ok: boolean; message: string }

async function realDeps(): Promise<StoragePlaceDeps> {
  const guard = await import("./switched-drive-guard")
  const pilot = await import("./formation-pilot")
  return { companyState: guard.companyDocState, liveOwnerOfContact: guard.liveOwnerOfContact, ensurePersonOwner: pilot.ensurePersonOwner }
}

export async function companyStoragePlace(accountId: string | null | undefined, deps?: StoragePlaceDeps): Promise<StoragePlace> {
  if (!accountId) return { ok: false, message: "This has no company attached, so there is nowhere to save it. Nothing was generated — pick the company and try again." }
  const d = deps ?? (await realDeps())
  const state = await d.companyState(accountId)
  if (state === "drive") return { ok: false, message: "This company has no storage place yet, so nothing was generated. Set up its storage first, or do this one by hand." }
  if (state === "moving") return { ok: false, message: "This company's files are being moved right now, so nothing was generated. Try again in a few minutes." }
  return { ok: true, message: "" }
}

export async function personStoragePlace(contactId: string | null | undefined, name: string, deps?: StoragePlaceDeps): Promise<StoragePlace> {
  if (!contactId) return { ok: false, message: "This form is not linked to a person yet, so nothing was generated. Open the form, choose the person, and try again." }
  const d = deps ?? (await realDeps())
  if (await d.liveOwnerOfContact(contactId)) return { ok: true, message: "" }
  await d.ensurePersonOwner(contactId, name || "Member")
  return { ok: true, message: "" }
}
