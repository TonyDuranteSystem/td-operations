/**
 * SS-4 responsible-party (signer) decision rules.
 *
 * HONESTY NOTE on "single source of truth": `decideSs4Signer` is the shared
 * MMLLC rule for the CRM generate path and refreshSS4 — but `createSS4`
 * (lib/operations/ss4.ts:140-192) still carries its OWN inline copy of the same
 * rule rather than importing this one. The two are kept in sync by hand; if you
 * change the rule here, change it there too. (Unifying them is desirable but is
 * a behaviour-preserving refactor for its own change, not a drive-by.)
 *
 * Why this exists: there are two SS-4 generation paths —
 *   1. lib/operations/ss4.ts::createSS4  (flow Workspace button + ss4_create MCP tool
 *      + the "SS-4 Prepared" stage-advance auto-generate hook)
 *   2. app/api/crm/admin-actions/generate-document/route.ts::generateSS4 (CRM account page)
 * Historically only path (1) enforced the MMLLC signer rule; path (2) just took the
 * first linked contact, which is how the wrong responsible party (Gaia instead of
 * Michele on AI Venture Labs LLC) was stamped on an SS-4.
 *
 * ─── TWO RULES LIVE HERE. THEY APPLY TO DIFFERENT POPULATIONS. ───
 *
 * `decideSs4Signer` — the MMLLC BLOCKING rule, driven by the `members` table.
 *   - Multi-member LLC (MMLLC, >1 member): exactly ONE member must be flagged
 *     `is_signer=true`. Zero or more-than-one → BLOCK and alert staff to fix it in
 *     the Members section before continuing. (Antonio, 2026-06-24; reaffirmed
 *     2026-08-10: "Multi-member rule stands. MMLLCs keep the existing stop-and-ask
 *     block — that protection stays exactly as it is.")
 *   - A single member row (SMLLC / Corporation) is unambiguous — use it.
 *
 * `pickDefaultSs4SignerLink` — the SMLLC DEFAULT rule, driven by `account_contacts`.
 *   NOTE (2026-08-10): `decideSs4Signer` NEVER sees a single-member LLC.
 *   `formation-materialize.ts` writes the owner `members` row only `if (isMMLC)`, so
 *   every SMLLC has ZERO member rows and falls through to the account_contacts
 *   fallback — that fallback is the PRIMARY path for single-member formations, not a
 *   legacy edge case. It used to take `links[0]` from an UNORDERED select with no role
 *   filter (`account_contacts` has no created_at, so that was physical row order), which
 *   is how ACE Marketing Group LLC's SS-4 named the authorized representative instead
 *   of the owner.
 *
 * Rules for the default pick (Antonio, 2026-08-10 — read them before "improving" this):
 *   - The SS-4 responsible party is DECOUPLED FROM OWNERSHIP by design. An SMLLC's
 *     signer may hold no ownership at all. Roles are a HINT for a default, NEVER a
 *     constraint. Do not reintroduce a rule equating "signer" with "owner".
 *   - NEVER BLOCK a single-member company. The stage-advance hook must always produce
 *     an SS-4. A wrong default is acceptable *because* it is created as a draft and the
 *     signer picker on the workspace SS-4 card is the correction point; a formation that
 *     halts with no SS-4 is not acceptable.
 *   - Exactly one owner-type link → use it. Otherwise fall back to a STABLE pick
 *     (same input → same signer) so the behaviour is pinnable by a test; the old
 *     physical-row-order fallback was not reproducible.
 *
 * Both are pure (no DB, no I/O) so they are fully unit-testable. The caller is
 * responsible for querying members (ordered is_signer desc, is_primary desc) and for
 * resolving the chosen member to a contact_id (a company-type member resolves via its
 * representative).
 */

export type Ss4SignerMember = {
  is_signer?: boolean | null
  is_primary?: boolean | null
  member_type?: string | null
  full_name?: string | null
  company_name?: string | null
  contact_id?: string | null
  representative_name?: string | null
  representative_email?: string | null
}

export type Ss4SignerDecision =
  /** A definite member was chosen as the responsible party. */
  | { kind: "use_member"; member: Ss4SignerMember }
  /** MMLLC with the wrong number of flagged signers — caller must block + alert. */
  | { kind: "needs_signer"; signerCount: number; memberCount: number }
  /** No members rows at all — caller falls back to its legacy contact source. */
  | { kind: "no_members" }

/**
 * Decide the SS-4 responsible party from the account's members.
 * `members` MUST already be ordered is_signer desc, then is_primary desc, so that
 * the SMLLC / single-row branch picks the most-appropriate member first.
 */
export function decideSs4Signer(
  members: Ss4SignerMember[] | null | undefined,
  entityType: string,
): Ss4SignerDecision {
  if (!members || members.length === 0) return { kind: "no_members" }

  if (entityType === "MMLLC" && members.length > 1) {
    const signers = members.filter((m) => m.is_signer === true)
    if (signers.length !== 1) {
      return { kind: "needs_signer", signerCount: signers.length, memberCount: members.length }
    }
    return { kind: "use_member", member: signers[0] }
  }

  // SMLLC, Corporation, or a single member row: unambiguous — take the first
  // (caller has ordered is_signer/is_primary first).
  return { kind: "use_member", member: members[0] }
}

/** One `account_contacts` link, as the default-pick rule sees it. */
export type Ss4SignerLink = {
  contact_id: string
  /** Free text, case-inconsistent in production, and NULLABLE. */
  role?: string | null
}

/**
 * Role values that make a link the OBVIOUS default responsible party.
 * Matched on the whole normalized string — never as a substring, because
 * "Partner - Tax/NHR Consultant (Portugal)" must not match on "partner", and a
 * substring test for "owner" would silently miss "Sole Member".
 *
 * Deliberately EXCLUDES the bare "Member" / "member": `formation-materialize.ts`
 * writes the literal "Member" on every additional-member link, so it is a
 * materializer default rather than anyone's statement about who signs — it must
 * not out-vote a real owner label. It is not disqualifying either; a lone
 * "Member" link still wins the stable fallback below.
 */
const OWNER_TYPE_ROLES = new Set(["owner", "sole member"])

function normalizeRole(role: string | null | undefined): string {
  return (role ?? "").trim().toLowerCase()
}

/** True when this link's role marks it as an owner-type (default-signer) link. */
export function isOwnerTypeRole(role: string | null | undefined): boolean {
  return OWNER_TYPE_ROLES.has(normalizeRole(role))
}

/**
 * Choose the DEFAULT responsible-party link for an account that has no `members`
 * rows (i.e. every single-member LLC). NEVER returns null for a non-empty list and
 * NEVER blocks — see the rules in the module header.
 *
 * Precedence:
 *   1. Exactly one owner-type link  → that link.
 *   2. Anything else (zero owner-type links, or several) → the stable fallback:
 *      owner-type links first, then lowest contact_id. Deterministic by
 *      construction, so the same account always yields the same default and a test
 *      can pin it — unlike the physical-row-order pick this replaces.
 */
export function pickDefaultSs4SignerLink(
  links: Ss4SignerLink[] | null | undefined,
): Ss4SignerLink | null {
  if (!links || links.length === 0) return null

  const ownerLinks = links.filter((l) => isOwnerTypeRole(l.role))
  if (ownerLinks.length === 1) return ownerLinks[0]

  // Stable fallback — owner-type first, then lowest contact_id. Sort a copy: the
  // caller's array is its own query result and must not be mutated underneath it.
  return [...links].sort((a, b) => {
    const ao = isOwnerTypeRole(a.role) ? 0 : 1
    const bo = isOwnerTypeRole(b.role) ? 0 : 1
    if (ao !== bo) return ao - bo
    return a.contact_id < b.contact_id ? -1 : a.contact_id > b.contact_id ? 1 : 0
  })[0]
}

/**
 * Is the SS-4's CURRENT responsible party one of the account's members?
 *
 * THE PICK-WINS RULE (Antonio, 2026-08-10, final-diff council fix): the signer
 * may be anyone linked to the account — member or not — and once picked it
 * survives every regenerate, member edit, and refresh. "The bookkeeping bends
 * to the pick, never the reverse." So a refresh may RE-DERIVE the responsible
 * party from the members table ONLY when the currently stamped party is itself
 * a member; a non-member party is an explicit staff choice and is kept, and the
 * MMLLC flag rules don't apply to it (no block, no revert).
 *
 * Matching is on `members.contact_id` equality only — a company-type member
 * whose contact_id is null cannot match, which errs on the KEEPING side (never
 * silently swaps the stamped party). Pure, null-safe.
 */
export function currentPartyIsMember(
  members: Ss4SignerMember[] | null | undefined,
  currentContactId: string | null | undefined,
): boolean {
  if (!currentContactId || !members || members.length === 0) return false
  return members.some((m) => m.contact_id === currentContactId)
}

/**
 * Staff-facing alert shown when an MMLLC has zero or multiple flagged signers.
 * Names each member so staff know exactly what to fix in the Members section.
 */
export function ss4SignerAlertMessage(members: Ss4SignerMember[], signerCount: number): string {
  const lines = members.map((m, i) => {
    const name =
      m.member_type === "company"
        ? `${m.company_name || "Unknown company"}${m.representative_name ? ` (rep: ${m.representative_name})` : ""}`
        : m.full_name || "Unknown member"
    const flag = m.is_signer === true ? " ✓ signer" : ""
    return `  ${i + 1}. ${name}${flag}`
  })

  const fix =
    signerCount === 0
      ? "No signer is flagged. Open the Members section, flag exactly one member as the signer (responsible party), then generate the SS-4 again."
      : `${signerCount} members are flagged as signer. Open the Members section and leave exactly one flagged as the signer, then generate the SS-4 again.`

  return [
    `Cannot generate the SS-4: this is a Multi-Member LLC with ${members.length} members and ${signerCount === 0 ? "no" : `${signerCount}`} signer${signerCount === 1 ? "" : "s"} flagged.`,
    ``,
    `Members:`,
    ...lines,
    ``,
    fix,
  ].join("\n")
}
