/**
 * ONE place that says which storages face a client (Antonio 2026-10-24: "it must work for any folder I add in future besides
 * Business and My files — flexible, not hardcoded"). A storage is a CLIENT storage only when it belongs to a client company or
 * a person; EVERY other kind — Business, My files, and any kind added later — is a normal firm storage (no document type, no
 * "show to client", never shown to anyone outside the firm). So a new firm storage needs no code edit here; a new storage that
 * clients can see MUST be added to CLIENT_OWNER_KINDS (a unit test fails the day the database allows a kind this file has not classified).
 */
export const CLIENT_OWNER_KINDS: ReadonlySet<string> = new Set(["company", "person", "formation", "unfiled"])

export const isClientOwnerKind = (kind: string | null | undefined): boolean => !!kind && CLIENT_OWNER_KINDS.has(kind)

/** A normal firm storage: any known kind that is not a client storage. An unknown / missing kind is NOT trusted as internal. */
export const isInternalOwnerKind = (kind: string | null | undefined): boolean => !!kind && !CLIENT_OWNER_KINDS.has(kind)

/** A firm storage whose files belong to ONE person (My files): its documents are private to them, so saving one into a storage others can open deserves a warning. */
export const isPersonalAreaKind = (kind: string | null | undefined): boolean => kind === "private"
