/**
 * What a company's members still owe before its Operating Agreement can be issued, and the
 * rules for letting the primary owner fill it in from the portal (dev job d016d398, Antonio
 * 2026-10-20). Pure — no database — so it can be tested and shared by the create route, the
 * fix-members route and the pop-up.
 *
 * Antonio's rules:
 *   - an agreement can never be issued with fewer signers than members, so every member needs an
 *     email (a company member signs through its representative: name + email);
 *   - the agreement prints each member's address, so an individual needs street, city, country;
 *   - ownership percentages are the clients' legal fact — they may edit them, they must total 100;
 *   - two members with the same name MUST have different emails;
 *   - what is already filled in is never rewritten from the portal (only blanks are filled, plus
 *     the percentages), so nobody can swap another owner's signing email.
 */
import { normalizeEmail, normalizePersonName } from "@/lib/members/member-identity"

export interface RosterMember {
  id: string
  member_type: string
  full_name: string | null
  company_name: string | null
  email: string | null
  ownership_pct: number | null
  address_street: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  address_country: string | null
  representative_name: string | null
  representative_email: string | null
  /** The linked contact, when there is one — a company member signs through it (lib/members/signing-set.ts). */
  contact_id?: string | null
}

export type MissingField = "email" | "address_street" | "address_city" | "address_country" | "representative_name" | "representative_email"

/** Fields the pop-up may fill in (when blank), plus the percentage. */
export const FILLABLE_FIELDS = [
  "email", "address_street", "address_city", "address_state", "address_zip", "address_country",
  "representative_name", "representative_email",
] as const
export type FillableField = (typeof FILLABLE_FIELDS)[number]

export interface MemberEdit extends Partial<Record<FillableField, string | null>> {
  id: string
  ownership_pct?: number | null
}

const blank = (v: string | null | undefined) => !(v ?? "").trim()
export const isCompanyMember = (m: Pick<RosterMember, "member_type">) => m.member_type === "company"
export const memberLabel = (m: Pick<RosterMember, "full_name" | "company_name">) => (m.full_name || m.company_name || "A member").trim() || "A member"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
export const looksLikeEmail = (v: string | null | undefined) => EMAIL_RE.test((v ?? "").trim())

export function missingFields(m: RosterMember): MissingField[] {
  const out: MissingField[] = []
  if (isCompanyMember(m)) {
    // Same rule as resolveSigningSet: a company member signs through its linked contact OR a representative email.
    if (m.contact_id || !blank(m.representative_email)) return out
    out.push("representative_name", "representative_email")
    return out
  }
  if (blank(m.email)) out.push("email")
  if (blank(m.address_street)) out.push("address_street")
  if (blank(m.address_city)) out.push("address_city")
  if (blank(m.address_country)) out.push("address_country")
  return out
}

export function ownershipTotal(members: Array<Pick<RosterMember, "ownership_pct">>): number {
  return members.reduce((s, m) => s + (Number(m.ownership_pct) || 0), 0)
}

export const ownershipIsComplete = (members: Array<Pick<RosterMember, "ownership_pct">>) => Math.abs(ownershipTotal(members) - 100) <= 0.01

/** True when the pop-up is needed: something is missing, or the percentages do not total 100. */
export function rosterNeedsAttention(members: RosterMember[]): boolean {
  return members.some(m => missingFields(m).length > 0) || !ownershipIsComplete(members)
}

function setIfBlank(current: string | null, incoming: string | null | undefined): string | null {
  if (!blank(current)) return current
  const v = (incoming ?? "").trim()
  return v ? v : current
}

/** The roster after the edits: blanks filled, percentages replaced, everything already present left alone. */
export function applyMemberEdits<T extends RosterMember>(members: T[], edits: MemberEdit[]): T[] {
  const byId = new Map(edits.map(e => [e.id, e]))
  return members.map(m => {
    const e = byId.get(m.id)
    if (!e) return m
    const next: T = { ...m }
    for (const f of FILLABLE_FIELDS) next[f] = setIfBlank(m[f], e[f])
    if (e.ownership_pct !== undefined && e.ownership_pct !== null && Number.isFinite(Number(e.ownership_pct))) {
      next.ownership_pct = Number(e.ownership_pct)
    }
    return next
  })
}

/** The email that receives the person's signing link: the member's own, or a company member's representative. */
export const signingEmail = (m: RosterMember) => (isCompanyMember(m) ? m.representative_email : m.email)

/**
 * Plain-English reason the roster cannot be saved/issued, or null when it is fine. Checked AFTER the edits are
 * applied, so what the client typed is what is judged. `typedEmailIds`: when given, only those members' emails are
 * format-checked (the client can only fix what they typed — an old malformed email must not be a dead end here).
 */
export function rosterProblem(members: RosterMember[], opts: { typedEmailIds?: Set<string> } = {}): string | null {
  for (const m of members) {
    const miss = missingFields(m)
    if (miss.length > 0) return `${memberLabel(m)} still needs: ${miss.map(f => FIELD_LABELS[f]).join(", ")}.`
    const email = signingEmail(m)
    const checkFormat = opts.typedEmailIds ? opts.typedEmailIds.has(m.id) : true
    if (checkFormat && !blank(email) && !looksLikeEmail(email)) return `${memberLabel(m)}: "${email}" does not look like an email address.`
  }
  for (const m of members) {
    if (!Number.isFinite(Number(m.ownership_pct)) || Number(m.ownership_pct) <= 0) return `${memberLabel(m)}: the ownership percentage must be more than 0.`
  }
  if (!ownershipIsComplete(members)) return `The ownership percentages total ${Math.round(ownershipTotal(members) * 100) / 100}% — they must total exactly 100%.`

  // Same name => different email (Antonio 2026-10-20). Company members are compared by company name. Members with no
  // signing email on the row (a company that signs through its contact) cannot be compared and are skipped.
  const seen = new Map<string, string>()
  for (const m of members) {
    const email = normalizeEmail(signingEmail(m))
    if (!email) continue
    const person = isCompanyMember(m) ? normalizePersonName(m.company_name || m.full_name) : normalizePersonName(m.full_name)
    const key = `${person}|${email}`
    if (seen.has(key)) return `${memberLabel(m)} appears twice with the same name and the same email. Two members with the same name must have different emails.`
    seen.set(key, m.id)
  }
  return null
}

export const FIELD_LABELS: Record<MissingField, string> = {
  email: "email",
  address_street: "street address",
  address_city: "city",
  address_country: "country",
  representative_name: "representative's name",
  representative_email: "representative's email",
}

/** What the pop-up shows. */
export interface MemberGapView {
  id: string
  name: string
  member_type: string
  ownership_pct: number | null
  missing: MissingField[]
  values: Pick<RosterMember, FillableField>
}

export function toGapView(m: RosterMember): MemberGapView {
  return {
    id: m.id,
    name: memberLabel(m),
    member_type: m.member_type,
    ownership_pct: m.ownership_pct,
    missing: missingFields(m),
    values: {
      email: m.email, address_street: m.address_street, address_city: m.address_city, address_state: m.address_state,
      address_zip: m.address_zip, address_country: m.address_country,
      representative_name: m.representative_name, representative_email: m.representative_email,
    },
  }
}

/**
 * Who may generate the agreement: the company's PRIMARY member only (Antonio 2026-10-20: "the OA is always generated by the
 * primary contact"). A member row matches the logged-in person by contact id, else by the signing email on the row.
 * No row flagged primary => 'no_primary' (the caller decides; staff should flag one).
 */
export function primaryAccess(
  members: Array<Pick<RosterMember, "email" | "representative_email"> & { is_primary: boolean | null; is_signer?: boolean | null; contact_id: string | null }>,
  who: { contactId: string; email: string | null | undefined },
): "primary" | "not_primary" | "no_primary" {
  // Flagged primary; if nobody is, the flagged signer stands in. Nobody flagged at all => 'no_primary'.
  let primaries = members.filter(m => m.is_primary)
  if (primaries.length === 0) primaries = members.filter(m => m.is_signer)
  if (primaries.length === 0) return "no_primary"
  const mine = normalizeEmail(who.email)
  const hit = primaries.some(m =>
    m.contact_id === who.contactId
    || (!!mine && (normalizeEmail(m.email) === mine || normalizeEmail(m.representative_email) === mine)),
  )
  return hit ? "primary" : "not_primary"
}
