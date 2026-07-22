/**
 * What a PUBLIC operating-agreement signing page is allowed to receive.
 *
 * ⛔ WHY THIS FILE EXISTS — read before adding a field.
 *
 * Until this change, both public OA pages fetched the agreement row with
 * `select('*')` using the anon key, straight from the browser, and compared the
 * access code CLIENT-SIDE — after the whole row had already been delivered.
 * The policies on `oa_agreements` / `oa_signatures` were `USING (true)` for role
 * `public`, and `anon` held SELECT on both. Combined with a token derived from
 * the company name plus the year (company names are public in state business
 * registries), one unauthenticated PostgREST request returned, for ANY of the
 * 187 agreements: `access_code`, `ein_number`, `member_email`, `member_address`,
 * every member's name and ownership split — and, from `oa_signatures`, every
 * co-signer's personal signing code, which is the credential that authorises
 * signing AS that member.
 *
 * The fix has two halves and BOTH are load-bearing:
 *   1. the server verifies the code before returning anything (the route), and
 *   2. it returns only these fields (this file).
 * Half 2 matters on its own: the route runs with the service key, so a
 * `select('*')` there would re-open the leak to anyone who passes the gate —
 * including a co-signer, who legitimately holds a code but must never receive
 * another member's code.
 *
 * THE RULE: never return a credential or another party's contact detail.
 * `access_code` (either table) and `member_email` (either table) are NEVER sent
 * to the browser. The email gate is evaluated server-side (`emailGateMatches`)
 * precisely so the address never has to travel to be compared.
 * `account_id` / `contact_id` are withheld too — neither page renders them, and
 * they are internal identifiers that make cross-referencing other tables easier.
 *
 * Pure functions, no I/O, so the whitelist is unit-testable without a database.
 */

/** Columns the server may read. Kept explicit — never `*`. */
export const OA_AGREEMENT_SELECT = [
  "id",
  "token",
  "access_code",
  "member_email",
  "company_name",
  "state_of_formation",
  "formation_date",
  "ein_number",
  "entity_type",
  "manager_name",
  "member_name",
  "member_address",
  "member_ownership_pct",
  "members",
  "effective_date",
  "business_purpose",
  "initial_contribution",
  "fiscal_year_end",
  "accounting_method",
  "duration",
  "registered_agent_name",
  "registered_agent_address",
  "principal_address",
  "status",
  "language",
  "view_count",
  "viewed_at",
  "signed_at",
  "pdf_storage_path",
  "total_signers",
  "signed_count",
].join(", ")

export const OA_SIGNATURE_SELECT = [
  "id",
  "oa_id",
  "member_index",
  "member_name",
  "member_email",
  "access_code",
  "status",
  "signed_at",
  "signature_image_path",
  "view_count",
].join(", ")

/**
 * Never leaves the server, on either table.
 *
 * `email` is listed as well as `member_email` because the `members` JSONB holds
 * each member's address under the bare key `email` — caught when the route's
 * real output was inspected, not by reading the mapper. A nested blob is the
 * easiest place for a secret to ride along unnoticed.
 */
export const OA_NEVER_EXPOSED = ["access_code", "member_email", "email", "account_id", "contact_id"] as const

/**
 * The members list as the AGREEMENT ITSELF renders it: name, address, ownership
 * split, contribution. Email is dropped — nothing prints it.
 *
 * ⛔ `address` MUST stay. The multi-member template's Article 2.1 says "The
 * Members of the Company, THEIR ADDRESSES, and their respective ownership
 * interests are as follows:" and then prints each member's address. An earlier
 * revision of this file dropped it on the strength of grepping the two PAGES for
 * `m.address` — but the pages don't read it, the TEMPLATE does, and the rendered
 * template is what html2pdf captures into the executed PDF. Every multi-member
 * agreement signed after that would have shown "As on file with the Company"
 * where the addresses belong: a stored legal document materially different from
 * every one signed before it.
 *
 * The lesson worth keeping: when deciding whether a field is unused, check every
 * consumer of the DATA, not just the file you happen to be editing.
 *
 * Withholding a co-signer's address from a verified co-signer would be pointless
 * anyway — it is printed in the agreement they are signing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPublicMembers(members: any): any {
  if (!Array.isArray(members)) return members ?? null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return members.map((m: any) => ({
    name: m?.name,
    address: m?.address,
    ownership_pct: m?.ownership_pct,
    initial_contribution: m?.initial_contribution,
  }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/**
 * The agreement as the browser may see it: everything needed to RENDER the
 * document, and nothing that authorises anything.
 */
export function toPublicAgreement(row: Row) {
  return {
    id: row.id,
    token: row.token,
    company_name: row.company_name,
    state_of_formation: row.state_of_formation,
    formation_date: row.formation_date,
    ein_number: row.ein_number ?? null,
    entity_type: row.entity_type ?? null,
    manager_name: row.manager_name ?? null,
    member_name: row.member_name,
    member_address: row.member_address ?? null,
    member_ownership_pct: row.member_ownership_pct,
    members: toPublicMembers(row.members),
    effective_date: row.effective_date,
    business_purpose: row.business_purpose,
    initial_contribution: row.initial_contribution,
    fiscal_year_end: row.fiscal_year_end,
    accounting_method: row.accounting_method,
    duration: row.duration,
    registered_agent_name: row.registered_agent_name ?? null,
    registered_agent_address: row.registered_agent_address ?? null,
    principal_address: row.principal_address,
    status: row.status,
    language: row.language,
    view_count: row.view_count ?? 0,
    viewed_at: row.viewed_at ?? null,
    signed_at: row.signed_at ?? null,
    pdf_storage_path: row.pdf_storage_path ?? null,
    total_signers: row.total_signers ?? 1,
    signed_count: row.signed_count ?? 0,
  }
}

/**
 * A co-signer row as the browser may see it.
 *
 * `id` IS included: the signing page needs it to write its own signature row,
 * and a row id is not a credential (the access code is). It is deliberately
 * included for EVERY signer rather than only the current one, because the page
 * renders each member's signature block and status.
 */
export function toPublicSignature(row: Row) {
  return {
    id: row.id,
    oa_id: row.oa_id,
    member_index: row.member_index,
    member_name: row.member_name,
    status: row.status,
    signed_at: row.signed_at ?? null,
    signature_image_path: row.signature_image_path ?? null,
    view_count: row.view_count ?? 0,
  }
}

/**
 * Resolve which signer a per-member code refers to — server-side, so the codes
 * themselves never reach the browser to be compared.
 *
 * Returns the signer's index, or null when the code matches nobody. An empty or
 * missing code matches nobody: a blank code must never resolve to signer 0.
 */
export function resolveSignerIndex(signatures: Row[], signerCode: string | null | undefined): number | null {
  const code = (signerCode ?? "").trim()
  if (!code) return null
  const hit = signatures.find(s => (s.access_code ?? "") === code)
  return hit ? hit.member_index : null
}

/**
 * The address the email gate must match for this viewer, or null when the
 * agreement has no address on file (the gate is then skipped, as before).
 *
 * For a multi-member agreement the gate is the CURRENT SIGNER's address, not
 * the agreement's primary member — otherwise every co-signer would be asked for
 * someone else's email.
 */
export function emailGateFor(agreement: Row, signatures: Row[], signerIndex: number | null): string | null {
  if (signerIndex !== null) {
    const sig = signatures.find(s => s.member_index === signerIndex)
    return sig?.member_email || null
  }
  return agreement.member_email || null
}

/** Case-insensitive, whitespace-tolerant comparison. Never matches when no address is on file. */
export function emailGateMatches(expected: string | null, provided: string | null | undefined): boolean {
  if (!expected) return false
  return (provided ?? "").trim().toLowerCase() === expected.trim().toLowerCase()
}

/**
 * Defence in depth: assert a payload carries no credential before it is sent.
 * Cheap, and it turns a future careless `...row` spread into a caught mistake
 * rather than a silent re-leak.
 */
export function assertNoSecrets(payload: unknown): void {
  const seen: string[] = []
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return
    if (Array.isArray(v)) return v.forEach(walk)
    for (const [k, val] of Object.entries(v as Row)) {
      if ((OA_NEVER_EXPOSED as readonly string[]).includes(k)) seen.push(k)
      walk(val)
    }
  }
  walk(payload)
  if (seen.length) {
    // Manual dedupe — the repo targets ES5, so spreading a Set does not compile.
    const unique = seen.filter((k, i) => seen.indexOf(k) === i)
    throw new Error(`Refusing to expose operating-agreement secrets: ${unique.join(", ")}`)
  }
}
