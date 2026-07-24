/**
 * Public-view whitelist for the client-facing LEASE page.
 *
 * WHY THIS EXISTS.
 * The lease signing pages used to read the whole `lease_agreements` row with the
 * ANON key (`select('*')`) and compare the access code IN THE BROWSER — i.e. after
 * the entire row had already been delivered. The token is `${companySlug}-${year}`,
 * derivable from a public company name, so anyone could fetch any lease's
 * `access_code`, `tenant_ein`, `tenant_email` and all terms with the anon key that
 * ships in the JS bundle. Same hole the Operating Agreement closed on 2026-07-22.
 *
 * The fix is the OA fix: a server route verifies the code, and the browser only
 * ever receives this WHITELIST — never the credential (`access_code`) or the gate
 * address (`tenant_email`). Then anon SELECT on the table is revoked.
 */

// Columns the server READS (service key). Includes the two secrets so the route
// can check the code and evaluate the email gate — they are stripped before the
// browser ever sees them (see toPublicLease + SECRET_LEASE_FIELDS).
export const LEASE_SELECT = [
  "id", "token", "access_code",
  "tenant_company", "tenant_ein", "tenant_state", "tenant_contact_name",
  "tenant_email", "tenant_title",
  "landlord_name", "landlord_address", "landlord_signer", "landlord_title",
  "premises_address", "suite_number", "square_feet",
  "effective_date", "term_start_date", "term_end_date", "term_months", "contract_year",
  "monthly_rent", "yearly_rent", "security_deposit", "late_fee", "late_fee_per_day",
  "status", "language", "view_count", "signed_at", "pdf_storage_path", "account_id",
].join(", ")

// NEVER sent to the browser.
const SECRET_LEASE_FIELDS = ["access_code", "tenant_email", "account_id"] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toPublicLease(row: any) {
  return {
    id: row.id,
    token: row.token,
    tenant_company: row.tenant_company,
    tenant_ein: row.tenant_ein ?? null,
    tenant_state: row.tenant_state ?? null,
    tenant_contact_name: row.tenant_contact_name,
    tenant_title: row.tenant_title ?? null,
    landlord_name: row.landlord_name,
    landlord_address: row.landlord_address,
    landlord_signer: row.landlord_signer,
    landlord_title: row.landlord_title,
    premises_address: row.premises_address,
    suite_number: row.suite_number,
    square_feet: row.square_feet,
    effective_date: row.effective_date,
    term_start_date: row.term_start_date,
    term_end_date: row.term_end_date,
    term_months: row.term_months,
    contract_year: row.contract_year,
    monthly_rent: row.monthly_rent,
    yearly_rent: row.yearly_rent,
    security_deposit: row.security_deposit,
    late_fee: row.late_fee,
    late_fee_per_day: row.late_fee_per_day,
    status: row.status,
    language: row.language,
    view_count: row.view_count ?? 0,
    signed_at: row.signed_at ?? null,
    pdf_storage_path: row.pdf_storage_path ?? null,
  }
}

/** Belt-and-braces: throws if a secret ever ends up in the outbound payload. */
export function assertNoLeaseSecrets(payload: unknown): void {
  const json = JSON.stringify(payload)
  for (const f of SECRET_LEASE_FIELDS) {
    // access_code is the credential; tenant_email is the gate address; account_id
    // is internal. None belong in a client payload.
    if (new RegExp(`"${f}"\\s*:`).test(json)) {
      throw new Error(`lease public payload leaked a secret field: ${f}`)
    }
  }
}

/** Case-insensitive, whitespace-tolerant; never matches when no address is on file. */
export function leaseEmailMatches(expected: string | null | undefined, supplied: string | null | undefined): boolean {
  const e = (expected ?? "").trim().toLowerCase()
  const s = (supplied ?? "").trim().toLowerCase()
  return e.length > 0 && e === s
}
