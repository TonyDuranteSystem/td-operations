/**
 * Address book: what the CRM says a person IS. Pure and client-safe. Nothing here is written anywhere: the kind is worked out every time the page opens
 * from what the CRM already holds, so it can never go out of date and the Contacts data is never touched.
 *
 * The rules (Antonio, 14 Nov 2026, counts checked against the live CRM on 15 Nov):
 *  - A PARTNER row of the Partners page is a "Banker" when its type is "Banking Partner", otherwise a "Partner".
 *  - A CONTACT with a live link to an Active client account is a "Client with a company".
 *  - A CONTACT with any other account link (a closed or cancelled company, a one-time account) is a "Past or one-time client".
 *  - A CONTACT with no company: by its portal level — lead → "Lead", active or formation → "Individual client", onboarding → "Other", no level → "Not sorted yet".
 * "Not sorted yet" (and "Other") are the only kinds Antonio may re-type; the answer is kept in the address book's own table, never on the contact.
 */

export const CRM_KIND_IDS = ["company", "individual", "lead", "past", "partner", "banker", "other", "unsorted"] as const
export type CrmKind = (typeof CRM_KIND_IDS)[number]

/** The text for the row's "What they are" column and for the filter chip, in the order the chips are drawn. */
export const CRM_KIND_TEXT: Record<CrmKind, { row: string; chip: string }> = {
  company: { row: "Client with a company", chip: "Clients with a company" },
  individual: { row: "Individual client", chip: "Individual clients" },
  lead: { row: "Lead", chip: "Leads" },
  past: { row: "Past or one-time client", chip: "Past or one-time clients" },
  partner: { row: "Partner", chip: "Partners" },
  banker: { row: "Banker", chip: "Bankers" },
  other: { row: "Other", chip: "Other" },
  unsorted: { row: "Not sorted yet", chip: "Not sorted yet" },
}

/** The kinds a person may be given a type of Antonio's own for. A client, lead or partner is sorted already: the CRM decides that. */
export const RETYPABLE_KINDS: readonly CrmKind[] = ["unsorted", "other"]

/** One live link between a contact and a (non-test) company account, as the store reads it. */
export interface AccountLink {
  accountType: string | null
  accountStatus: string | null
  /** true once the link has been ended (the person left the company) */
  ended: boolean
}

export function classifyContact(c: { portalTier: string | null; links: readonly AccountLink[] }): CrmKind {
  if (c.links.some((l) => !l.ended && l.accountType === "Client" && l.accountStatus === "Active")) return "company"
  if (c.links.length > 0) return "past"
  const tier = (c.portalTier ?? "").trim().toLowerCase()
  if (!tier) return "unsorted"
  if (tier === "lead") return "lead"
  if (tier === "active" || tier === "formation") return "individual"
  return "other"
}

export function classifyPartner(partnerType: string | null | undefined): CrmKind {
  return (partnerType ?? "").trim().toLowerCase() === "banking partner" ? "banker" : "partner"
}

export function canRetype(kind: CrmKind): boolean {
  return RETYPABLE_KINDS.includes(kind)
}
