/**
 * Shared core for "get or create this account's member info request" — the
 * short form that collects/updates every member's real ownership + signing
 * data. Originally staff-only (app/api/accounts/[id]/member-info-form), now
 * also reachable by the client themselves from the Generate Documents screen
 * (dev job 9ad76300-6181-4250-a1de-c77f37933f82 / 9ad76300-6181-4250-a1de-c77f37933f82): if the Manager name the system resolved
 * doesn't look right, the fix is correcting the underlying member records
 * through this SAME form — never a name picker at generation time.
 *
 * Idempotent: a pending request for the account is reused rather than
 * duplicated, same as the staff caller already relied on.
 *
 * Does NOT send any notification — callers decide whether/how to tell someone
 * (the staff route chats an admin-styled message; the client route just hands
 * the requesting client a URL to go fill it in themselves).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { buildFormUrl, buildAdminPreviewUrl } from "@/lib/forms/smart-url"
import { resolveAccountSigner } from "@/lib/members/resolve-signer"

export type MemberInfoRequestResult =
  | {
      outcome: "ok"
      formUrl: string
      adminPreviewUrl: string
      isExisting: boolean
      companyName: string
      contactId: string
    }
  | { outcome: "error"; message: string }

/**
 * Who gets the request. Prefer the resolved signer (is_signer-first, same
 * rule as the lease/SS-4/OA) — but this form's whole purpose is fixing an
 * account's member data, so a "blocked" resolver outcome (an ambiguous
 * Multi-Member LLC — the exact shape this form exists to correct) must NOT
 * be a dead end here the way it correctly is everywhere else. Falls back, in
 * order: the member flagged Primary (with an email match if it has no
 * linked contact), then any contact linked to the account at all — getting
 * the form to SOMEONE who can fix the roster is the goal; legal precision
 * about who signs is exactly the open question being fixed.
 *
 * Read-only (no side effects) so both the staff GET (button-enable check)
 * and POST (actual send) — and getOrCreateMemberInfoRequest below — resolve
 * the SAME contact. Before dev job 9ad76300-6181-4250-a1de-c77f37933f82's second pass, the GET route
 * independently re-implemented an is_primary-ONLY check with no fallback,
 * so 3 real active accounts (TEDERE T, Univexa International, Full Throttle
 * Media) could be fixed via the client's own button but the staff Send
 * button stayed disabled for the exact same accounts.
 */
export async function resolveMemberInfoContact(accountId: string): Promise<string | null> {
  const signerResolution = await resolveAccountSigner(accountId)
  if (signerResolution.outcome === "resolved") {
    return signerResolution.contact.id
  }

  const { data: primaryMember } = await supabaseAdmin
    .from("members")
    .select("contact_id, email")
    .eq("account_id", accountId)
    .eq("is_primary", true)
    .maybeSingle()
  if (primaryMember?.contact_id) return primaryMember.contact_id
  if (primaryMember?.email) {
    const { data: contactByEmail } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("email", primaryMember.email)
      .limit(1)
      .maybeSingle()
    if (contactByEmail?.id) return contactByEmail.id
  }

  const { data: anyLink } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id")
    .eq("account_id", accountId)
    .limit(1)
    .maybeSingle()
  return anyLink?.contact_id ?? null
}

export async function getOrCreateMemberInfoRequest(accountId: string): Promise<MemberInfoRequestResult> {
  const { data: account, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, entity_type")
    .eq("id", accountId)
    .single()

  if (accErr || !account) {
    return { outcome: "error", message: "Account not found" }
  }

  // Dev job 9ad76300-6181-4250-a1de-c77f37933f82 (5 real accounts had no Primary flagged at all and
  // dead-ended here before this fix).
  const contactId = await resolveMemberInfoContact(accountId)

  if (!contactId) {
    return { outcome: "error", message: "No contact is linked to this account yet. Contact support to have this corrected." }
  }

  // Idempotent: reuse a pending request rather than creating a second one.
  const { data: existing } = await supabaseAdmin
    .from("member_info_requests")
    .select("id, token, access_code, status")
    .eq("account_id", accountId)
    .eq("status", "pending")
    .maybeSingle()

  let token: string
  let accessCode: string
  let isExisting = false

  if (existing) {
    token = existing.token
    accessCode = existing.access_code
    isExisting = true
  } else {
    // Pre-populate from the existing members table.
    const { data: members } = await supabaseAdmin
      .from("members")
      .select(
        "member_type, full_name, company_name, ein, email, phone, ownership_pct, is_primary, " +
        "address_street, address_city, address_state, address_zip, address_country, " +
        "representative_name, representative_email, representative_phone, " +
        "representative_address_street, representative_address_city, " +
        "representative_address_state, representative_address_zip, representative_address_country"
      )
      .eq("account_id", accountId)
      .order("is_primary", { ascending: false })

    const prePopulatedData = members?.length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? { members: (members as any[]).map(m => ({ ...m, ownership_pct: m.ownership_pct ? String(m.ownership_pct) : "" })) }
      : null

    const { data: created, error: createErr } = await supabaseAdmin
      .from("member_info_requests")
      .insert({
        account_id: accountId,
        contact_id: contactId,
        status: "pending",
        company_name: account.company_name,
        entity_type: account.entity_type ?? "Multi Member LLC",
        pre_populated_data: prePopulatedData,
      })
      .select("id, token, access_code")
      .single()

    if (createErr || !created) {
      return { outcome: "error", message: createErr?.message ?? "Failed to create form" }
    }

    token = created.token
    accessCode = created.access_code
  }

  const formUrl = await buildFormUrl({ contactId, token, accessCode, formType: "member_info" })
  const adminPreviewUrl = buildAdminPreviewUrl("member_info", token, accessCode)

  return { outcome: "ok", formUrl, adminPreviewUrl, isExisting, companyName: account.company_name, contactId }
}
