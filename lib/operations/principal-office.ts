/**
 * Principal office — the address on the company's Articles of Organization (the state-filed address; it can be
 * anywhere). It is NOT what the EIN, lease or Operating Agreement print — those always use Largo + the company's own
 * suite (lib/addresses.ts → withCompanyCmra). It can change, and the State Annual Report is where the state shows it:
 * when an annual report is filed, staff answer "did the principal address change?" (Antonio 2026-10-01) and, if it did,
 * the new address replaces the saved Principal Office in the same step.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { formatAddressString } from "@/lib/addresses"

export type PrincipalOfficeDecision =
  | { changed: false }
  | { changed: true; address_line1: string; address_line2: string | null; city: string; state: string; zip: string }

export type ParsedDecision =
  | { ok: true; decision: PrincipalOfficeDecision; error?: undefined }
  | { ok: false; error: string; decision?: undefined }

const MISSING = "Say whether the principal address changed on the filed annual report (unchanged, or enter the new address)."

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : ""
}

/** Validate what the dialog / card sent. Pure. */
export function parsePrincipalOfficeDecision(raw: unknown): ParsedDecision {
  if (!raw || typeof raw !== "object") return { ok: false, error: MISSING }
  const r = raw as Record<string, unknown>
  if (r.changed === false) return { ok: true, decision: { changed: false } }
  if (r.changed !== true) return { ok: false, error: MISSING }
  const address_line1 = clean(r.address_line1, 200)
  const city = clean(r.city, 100)
  const state = clean(r.state, 60)
  const zip = clean(r.zip, 20)
  const missing = [
    !address_line1 && "street",
    !city && "city",
    !state && "state",
    !zip && "ZIP",
  ].filter(Boolean)
  if (missing.length) {
    return { ok: false, error: `The new principal address is missing: ${missing.join(", ")}.` }
  }
  return {
    ok: true,
    decision: { changed: true, address_line1, address_line2: clean(r.address_line2, 200) || null, city, state, zip },
  }
}

/** The company's saved Principal Office as one line, or null if none is on file. */
export async function getPrincipalOfficeText(accountId: string): Promise<string | null> {
  const { data: acct, error } = await supabaseAdmin
    .from("accounts")
    .select("business_legal_address_id")
    .eq("id", accountId)
    .maybeSingle()
  if (error) throw new Error(`Could not read the principal office: ${error.message}`)
  const addrId = (acct as { business_legal_address_id?: string | null } | null)?.business_legal_address_id
  if (!addrId) return null
  const { data: addr } = await supabaseAdmin
    .from("addresses")
    .select("address_line1, address_line2, city, state, zip")
    .eq("id", addrId)
    .maybeSingle()
  return formatAddressString(addr as Parameters<typeof formatAddressString>[0])
}

export interface ApplyPrincipalOfficeResult {
  changed: boolean
  address: string | null
  address_id: string | null
}

/**
 * Record the decision made while filing the annual report. "Unchanged" only writes the dated note. "Changed" saves the
 * new address as the company's Principal Office (reusing an identical saved address if there is one) and marks the
 * link verified. Both append a dated line to the account notes (CRM update rule).
 */
export async function applyPrincipalOfficeDecision(opts: {
  accountId: string
  decision: PrincipalOfficeDecision
  actor: string
  filedDate: string
  year: number
}): Promise<ApplyPrincipalOfficeResult> {
  const { accountId, decision, actor, filedDate, year } = opts
  const { data: acct, error: acctErr } = await supabaseAdmin
    .from("accounts")
    .select("company_name, notes")
    .eq("id", accountId)
    .maybeSingle()
  if (acctErr || !acct) throw new Error(`Account ${accountId} not found: ${acctErr?.message ?? "unknown"}`)
  const company = (acct as { company_name: string }).company_name
  const notes = (acct as { notes: string | null }).notes

  const appendNote = async (line: string) => {
    // eslint-disable-next-line no-restricted-syntax -- audit line on the account (CRM update rule), same as file-renewal
    await supabaseAdmin
      .from("accounts")
      .update({ notes: notes ? `${notes}\n${line}` : line, updated_at: new Date().toISOString() })
      .eq("id", accountId)
  }

  if (!decision.changed) {
    await appendNote(`${filedDate}: Annual Report ${year} — address on the Articles confirmed unchanged (${actor})`)
    return { changed: false, address: await getPrincipalOfficeText(accountId), address_id: null }
  }

  const before = await getPrincipalOfficeText(accountId)
  // reuse an identical saved principal-office address instead of duplicating it
  const { data: existing } = await supabaseAdmin
    .from("addresses")
    .select("id")
    .eq("kind", "business_legal")
    .eq("active", true)
    .ilike("address_line1", decision.address_line1)
    .ilike("city", decision.city)
    .ilike("state", decision.state)
    .ilike("zip", decision.zip)
    .limit(1)
  let addressId = (existing as Array<{ id: string }> | null)?.[0]?.id ?? null
  if (!addressId) {
    const { data: created, error: insErr } = await supabaseAdmin
      .from("addresses")
      .insert({
        kind: "business_legal",
        name: `${company} — principal office`,
        address_line1: decision.address_line1,
        address_line2: decision.address_line2,
        city: decision.city,
        state: decision.state,
        zip: decision.zip,
        country: "US",
        is_td_provided: false,
        active: true,
        notes: `Set from the ${year} annual report (filed ${filedDate})`,
        created_by: actor,
      })
      .select("id")
      .single()
    if (insErr || !created) throw new Error(`Could not save the new principal address: ${insErr?.message ?? "unknown"}`)
    addressId = (created as { id: string }).id
  }

  // eslint-disable-next-line no-restricted-syntax -- relinking the company's principal office; same write the CRM address picker makes
  const { error: linkErr } = await supabaseAdmin
    .from("accounts")
    .update({ business_legal_address_id: addressId, legal_link_verified: true, updated_at: new Date().toISOString() })
    .eq("id", accountId)
  if (linkErr) throw new Error(`Could not link the new principal address: ${linkErr.message}`)

  const after = formatAddressString({
    address_line1: decision.address_line1, address_line2: decision.address_line2,
    city: decision.city, state: decision.state, zip: decision.zip,
  })
  await appendNote(`${filedDate}: Annual Report ${year} — address on the Articles CHANGED: ${before ?? "(none on file)"} → ${after} (${actor})`)
  return { changed: true, address: after, address_id: addressId }
}
