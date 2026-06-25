/**
 * SS-4 responsible-party (signer) decision rule — the SINGLE source of truth for
 * "which member signs the SS-4, and when must we block and ask staff to flag one".
 *
 * Why this exists: there are two SS-4 generation paths —
 *   1. lib/operations/ss4.ts::createSS4  (flow Workspace button + ss4_create MCP tool)
 *   2. app/api/crm/admin-actions/generate-document/route.ts::generateSS4 (CRM account page)
 * Historically only path (1) enforced the MMLLC signer rule; path (2) just took the
 * first linked contact, which is how the wrong responsible party (Gaia instead of
 * Michele on AI Venture Labs LLC) was stamped on an SS-4. Both paths now call
 * `decideSs4Signer` so the blocking rule can never drift between them.
 *
 * Rule (Antonio, 2026-06-24):
 *   - Single-member LLC (SMLLC): the owner signs — no alert, unambiguous.
 *   - Multi-member LLC (MMLLC, >1 member): exactly ONE member must be flagged
 *     `is_signer=true`. Zero or more-than-one → BLOCK and alert staff to fix it in
 *     the Members section before continuing.
 *
 * Pure (no DB, no I/O) so it is fully unit-testable. The caller is responsible for
 * querying members (ordered is_signer desc, is_primary desc) and for resolving the
 * chosen member to a contact_id (a company-type member resolves via its
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
