/**
 * ONE place that classifies every kind of storage (Antonio 2026-10-24: "it must work for any folder I add in future besides
 * Business and My files — flexible, not hardcoded"). Every kind the database allows (`store_owners.kind`) is either a CLIENT
 * storage (a company or a person: clients can see its files) or a FIRM storage (Business, My files…: never shown to a client,
 * no document type, no protection flags). Everything that decides "is this a firm storage?" — the merge rules, the upload
 * gate, the Mac app's save rule, the Google Drive copy — asks THIS file, so adding a storage later is ONE line here plus the
 * database change, never a hunt through the code.
 *
 * A kind listed in neither set is NOT trusted: the server paths refuse it (deny by default — an unrecognised kind must never
 * skip a client check). The unit test `crm-store-owner-kinds.test.ts` compares both sets with the kinds the database allows,
 * so a newly allowed kind fails the tests until it is classified here.
 */
export const CLIENT_OWNER_KINDS: ReadonlySet<string> = new Set(["company", "person", "formation", "unfiled"])
/** Firm storages: the firm's own areas. To add a new one, add its kind here (and in the database CHECK). */
export const FIRM_OWNER_KINDS: ReadonlySet<string> = new Set(["business", "private"])

export const isClientOwnerKind = (kind: string | null | undefined): boolean => !!kind && CLIENT_OWNER_KINDS.has(kind)

/** A normal firm storage (Business, My files, any registered later). An unknown / missing kind is never one. */
export const isInternalOwnerKind = (kind: string | null | undefined): boolean => !!kind && FIRM_OWNER_KINDS.has(kind)

/** A firm storage whose files belong to ONE person (My files): its documents are private to them, so saving one into a storage others can open deserves a warning. */
export const isPersonalAreaKind = (kind: string | null | undefined): boolean => kind === "private"
