/**
 * Admin Action: Generate Document (OA, Lease, SS-4) or Send Document
 *
 * POST /api/crm/admin-actions/generate-document
 *
 * Body:
 *   action: "generate_oa" | "generate_lease" | "generate_ss4" | "send_oa" | "send_lease" | "generate_welcome_package"
 *   account_id: string (UUID)
 *   ...params (varies by action)
 */

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { APP_BASE_URL } from "@/lib/config"
import { OA_SUPPORTED_STATES } from "@/lib/types/oa-templates"
import { createClient } from "@/lib/supabase/server"
import { canPerform } from "@/lib/permissions"
import { formatCountyAndState } from "@/lib/addresses"
import { decideSs4Signer, ss4SignerAlertMessage, type Ss4SignerMember } from "@/lib/operations/ss4-signer"

const OA_BASE_URL = `${APP_BASE_URL}/operating-agreement`
const LEASE_BASE_URL = `${APP_BASE_URL}/lease`
const SS4_BASE_URL = `${APP_BASE_URL}/ss4`

// ─── Helpers ───

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

const STATE_MAP: Record<string, string> = {
  "NEW MEXICO": "NM", "NM": "NM",
  "WYOMING": "WY", "WY": "WY",
  "FLORIDA": "FL", "FL": "FL",
  "DELAWARE": "DE", "DE": "DE",
}

const ENTITY_MAP: Record<string, string> = {
  "SINGLE MEMBER LLC": "SMLLC", "SMLLC": "SMLLC",
  "MULTI-MEMBER LLC": "MMLLC", "MULTI MEMBER LLC": "MMLLC", "MMLLC": "MMLLC",
  "CORPORATION": "Corporation", "CORP": "Corporation", "C-CORP": "Corporation",
}

async function fetchAccountAndContact(accountId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: account, error: accErr } = await (supabaseAdmin as any)
    .from("accounts")
    .select("id, company_name, ein_number, entity_type, state_of_formation, formation_date, registered_agent_id")
    .eq("id", accountId)
    .single()

  if (accErr || !account) {
    return { error: `Account not found: ${accErr?.message || "no data"}` }
  }

  const { data: contactLinks } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, role")
    .eq("account_id", accountId)

  if (!contactLinks?.length) {
    return { error: `No contacts linked to account "${account.company_name}". Link a contact first.` }
  }

  const { data: contact, error: ctErr } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, email, phone, residency, language, itin_number")
    .eq("id", contactLinks[0].contact_id)
    .single()

  if (ctErr || !contact) {
    return { error: `Contact not found: ${ctErr?.message || "no data"}` }
  }

  return { account, contact, contactLinks }
}

// ─── Generate OA ───

async function generateOA(accountId: string, params: Record<string, unknown>) {
  const result = await fetchAccountAndContact(accountId)
  if ("error" in result) return { error: result.error }
  const { account, contact, contactLinks } = result

  const entityType = (params.entity_type as string) || (() => {
    const raw = (account.entity_type || "").toUpperCase().trim()
    if (raw.includes("MULTI")) return "MMLLC"
    return "SMLLC"
  })()

  // Validate state
  const rawState = (account.state_of_formation || "").toUpperCase().trim()
  const state = STATE_MAP[rawState] || rawState
  if (!OA_SUPPORTED_STATES.includes(state as typeof OA_SUPPORTED_STATES[number])) {
    return { error: `State "${account.state_of_formation}" not supported for OA. Supported: ${OA_SUPPORTED_STATES.join(", ")}` }
  }

  // Validate effective_date 60-day cap
  const today = new Date().toISOString().slice(0, 10)
  const effectiveDate = (params.effective_date as string) || today
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  if (effectiveDate < cutoff) {
    return { error: `Effective date cannot be more than 60 days in the past. Earliest allowed: ${cutoff}` }
  }

  // Check duplicate
  const { data: existing } = await supabaseAdmin
    .from("oa_agreements")
    .select("id, token, status, effective_date")
    .eq("account_id", accountId)
    .limit(1)

  if (existing?.length && !params.force_recreate) {
    return { exists: true, token: existing[0].token, status: existing[0].status, effective_date: existing[0].effective_date }
  }

  // force_recreate: delete existing OA (and MMLLC signatures) before recreating
  if (existing?.length && params.force_recreate) {
    await supabaseAdmin.from("oa_signatures").delete().eq("oa_id", existing[0].id)
    const { error: delErr } = await supabaseAdmin.from("oa_agreements").delete().eq("id", existing[0].id)
    if (delErr) return { error: `Failed to delete existing OA: ${delErr.message}` }
  }

  const year = new Date().getFullYear()
  const token = `${slugify(account.company_name)}-oa-${year}`

  // For MMLLC, auto-build members from account_contacts
  let membersJson = null
  if (entityType === "MMLLC" && contactLinks!.length >= 2) {
    const contactIds = contactLinks!.map(cl => cl.contact_id)
    const { data: allContacts } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, email, residency")
      .in("id", contactIds)

    if (allContacts) {
      const pct = Math.floor(100 / allContacts.length)
      const remainder = 100 - (pct * allContacts.length)
      membersJson = allContacts.map((c, i) => ({
        name: c.full_name,
        email: c.email || null,
        address: c.residency || null,
        ownership_pct: i === 0 ? pct + remainder : pct,
        initial_contribution: "$0.00",
      }))
    }
  }

  const { data: oa, error: insertErr } = await supabaseAdmin
    .from("oa_agreements")
    .insert({
      token,
      account_id: accountId,
      contact_id: contact.id,
      company_name: account.company_name,
      state_of_formation: state,
      formation_date: account.formation_date || today,
      ein_number: account.ein_number || null,
      entity_type: entityType,
      manager_name: (params.manager_name as string) || contact.full_name,
      member_name: contact.full_name,
      member_address: contact.residency || null,
      member_email: contact.email || null,
      members: membersJson,
      effective_date: effectiveDate,
      business_purpose: "any and all lawful business activities",
      initial_contribution: "$0.00",
      fiscal_year_end: "December 31",
      accounting_method: "Cash",
      duration: "Perpetual",
      principal_address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
      language: "en",
      status: "draft",
    })
    .select("id, token, access_code")
    .single()

  if (insertErr || !oa) {
    return { error: `Insert failed: ${insertErr?.message || "no data"}` }
  }

  logAction({
    actor: "crm-admin",
    action_type: "create",
    table_name: "oa_agreements",
    record_id: oa.id,
    account_id: accountId,
    summary: `Created ${entityType} Operating Agreement for ${account.company_name} (${state})`,
    details: { token: oa.token, state, entity_type: entityType, source: "crm-button" },
  })

  return {
    success: true,
    token: oa.token,
    access_code: oa.access_code,
    admin_preview: `${OA_BASE_URL}/${oa.token}?preview=td`,
    client_url: `${OA_BASE_URL}/${oa.token}/${oa.access_code}`,
    entity_type: entityType,
    company_name: account.company_name,
  }
}

// ─── Generate Lease ───

async function generateLease(accountId: string, params: Record<string, unknown>) {
  const accResult = await fetchAccountAndContact(accountId)
  if ("error" in accResult) return { error: accResult.error }
  const { account } = accResult

  const { createLease } = await import("@/lib/operations/lease")
  const result = await createLease({
    account_id: accountId,
    suite_number: params.suite_number as string | undefined,
    contract_year: params.contract_year as number | undefined,
    effective_date: params.effective_date as string | undefined,
    monthly_rent: params.monthly_rent as number | undefined,
    yearly_rent: params.yearly_rent as number | undefined,
    security_deposit: params.security_deposit as number | undefined,
    square_feet: params.square_feet as number | undefined,
    actor: "crm-admin",
    summary: `Created lease via CRM Generate Document button for ${account.company_name}`,
    details: { source: "crm-button" },
  })

  if (result.outcome === "duplicate" && result.existing) {
    return { exists: true, token: result.existing.token, status: result.existing.status }
  }
  if (!result.success || !result.lease) {
    return { error: result.error || "Insert failed" }
  }
  const lease = result.lease

  return {
    success: true,
    token: lease.token,
    access_code: lease.access_code,
    admin_preview: `${LEASE_BASE_URL}/${lease.token}?preview=td`,
    client_url: `${LEASE_BASE_URL}/${lease.token}/${lease.access_code}`,
    suite_number: lease.suite_number,
    company_name: account.company_name,
  }
}

// ─── Generate SS-4 ───

async function generateSS4(accountId: string, opts?: { regenerate?: boolean }) {
  const result = await fetchAccountAndContact(accountId)
  if ("error" in result) return { error: result.error }
  const { account, contact, contactLinks } = result

  if (!account.state_of_formation) {
    return { error: `Account "${account.company_name}" missing state_of_formation.` }
  }

  // Duplicate / regenerate handling. Without `regenerate`, an existing row
  // short-circuits (unchanged behavior). With `regenerate: true`, an UNSIGNED
  // SS-4 (draft / awaiting_signature, never signed) is refreshed IN PLACE from
  // the account's current state — same token, so the link the client already
  // has shows the corrected form. A signed/submitted/faxed SS-4 is locked:
  // the client signed that exact document; it must never be rewritten.
  // (2026-06-11 LUMA incident: account entity type was corrected after the
  // SS-4 went out as SMLLC, and there was no way to regenerate from the CRM.)
  const { data: existing } = await supabaseAdmin
    .from("ss4_applications")
    .select("id, token, access_code, status, signed_at")
    .eq("account_id", accountId)
    .maybeSingle()

  if (existing && !opts?.regenerate) {
    return { exists: true, token: existing.token, status: existing.status }
  }
  if (existing && opts?.regenerate) {
    const unsigned = !existing.signed_at && (existing.status === "draft" || existing.status === "awaiting_signature")
    if (!unsigned) {
      return { error: `SS-4 ${existing.token} is "${existing.status}" — a signed or submitted SS-4 cannot be regenerated. Create the correction manually with support.` }
    }
  }

  const rawEntity = (account.entity_type || "").toUpperCase().trim()
  const entityType = ENTITY_MAP[rawEntity] || "SMLLC"
  const state = STATE_MAP[(account.state_of_formation || "").toUpperCase().trim()] || account.state_of_formation

  // Responsible party defaults to the first linked contact (the SMLLC owner). For
  // a multi-member LLC the responsible party MUST be the member flagged as signer
  // — and we BLOCK with a staff alert if zero or more than one is flagged. This is
  // the SAME rule createSS4 enforces (lib/operations/ss4.ts), shared via
  // decideSs4Signer so the two SS-4 paths can never drift. Without this, the CRM
  // path silently stamped the first linked contact (the Gaia/Michele bug).
  let responsibleContact = contact

  // Member count: members table first (company members aren't account_contacts),
  // then contact links — and never below 2 for a non-SMLLC: a multi-member LLC
  // has ≥2 members by definition, even when only the owner is linked in the
  // CRM yet (the LUMA case: entity corrected to MMLLC before the second
  // member was linked).
  let memberCount = 1
  if (entityType !== "SMLLC") {
    const { data: membersRows } = await supabaseAdmin
      .from("members")
      .select("id, member_type, full_name, company_name, contact_id, representative_name, representative_email, is_primary, is_signer")
      .eq("account_id", accountId)
      .order("is_signer", { ascending: false })
      .order("is_primary", { ascending: false })

    const base = membersRows && membersRows.length > 0 ? membersRows.length : (contactLinks!.length || 0)
    memberCount = Math.max(base, 2)

    const decision = decideSs4Signer(membersRows as Ss4SignerMember[] | null, entityType)
    if (decision.kind === "needs_signer") {
      return { error: ss4SignerAlertMessage(membersRows as Ss4SignerMember[], decision.signerCount) }
    }
    if (decision.kind === "use_member") {
      const m = decision.member
      let signerContactId = m.contact_id ?? null
      if (!signerContactId && m.member_type === "company" && m.representative_email) {
        const { data: repC } = await supabaseAdmin.from("contacts").select("id").eq("email", m.representative_email).maybeSingle()
        signerContactId = repC?.id ?? null
      }
      if (signerContactId && signerContactId !== contact.id) {
        const { data: signerC } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, email, phone, residency, language, itin_number")
          .eq("id", signerContactId)
          .single()
        if (signerC) responsibleContact = signerC
      }
    }
    // decision.kind === "no_members" → keep the first linked contact (legacy fallback)
  }

  // Resolve Line 6 (county_and_state) from the addresses registry via FK join.
  // TD operating rule (Antonio, 2026-04-30): RA address is the source for Line 6.
  // Path 2: no fallback — if registered_agent_id unset or county blank, return error.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raId = (account as any).registered_agent_id as string | null
  if (!raId) {
    return { error: `No Registered Agent set for ${account.company_name}. Link a Registered Agent in the addresses registry before generating an SS-4.` }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: raAddress } = await (supabaseAdmin as any)
    .from("addresses")
    .select("county, state")
    .eq("id", raId)
    .single()
  if (!raAddress?.county) {
    return { error: `Registered Agent address for ${account.company_name} is missing county. Set the county in the addresses registry, then retry.` }
  }
  const resolvedCountyAndState = formatCountyAndState(raAddress.county, raAddress.state)

  const slug = slugify(account.company_name)
  const token = `ss4-${slug}-${new Date().getFullYear()}`
  const title = entityType === "SMLLC" ? "Owner" : entityType === "MMLLC" ? "Member" : "President"

  // Regenerate path: refresh the existing unsigned row in place. Token and
  // access_code are preserved so the client's existing link stays valid; the
  // SS-4 page renders live from this row, so the corrected values appear at
  // the same URL immediately.
  if (existing && opts?.regenerate) {
    const { error: updErr } = await supabaseAdmin
      .from("ss4_applications")
      .update({
        company_name: account.company_name,
        entity_type: entityType,
        state_of_formation: state,
        formation_date: account.formation_date || null,
        member_count: memberCount,
        contact_id: responsibleContact.id,
        responsible_party_name: responsibleContact.full_name,
        responsible_party_itin: responsibleContact.itin_number || null,
        responsible_party_phone: responsibleContact.phone || null,
        responsible_party_title: title,
        language: responsibleContact.language === "Italian" ? "it" : "en",
        county_and_state: resolvedCountyAndState,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)

    if (updErr) {
      return { error: `Regenerate failed: ${updErr.message}` }
    }

    logAction({
      actor: "crm-admin",
      action_type: "update",
      table_name: "ss4_applications",
      record_id: existing.id,
      account_id: accountId,
      summary: `Regenerated SS-4 for ${account.company_name} (${entityType}, ${state}, ${memberCount} member${memberCount === 1 ? "" : "s"}) — same token, link unchanged`,
      details: { token: existing.token, entity_type: entityType, state, member_count: memberCount, source: "crm-button-regenerate" },
    })

    return {
      success: true,
      regenerated: true,
      token: existing.token,
      access_code: existing.access_code,
      admin_preview: `${SS4_BASE_URL}/${existing.token}/${existing.access_code}?preview=td`,
      entity_type: entityType,
      company_name: account.company_name,
    }
  }

  const { data: ss4, error: insertErr } = await supabaseAdmin
    .from("ss4_applications")
    .insert({
      token,
      account_id: accountId,
      contact_id: responsibleContact.id,
      company_name: account.company_name,
      entity_type: entityType,
      state_of_formation: state,
      formation_date: account.formation_date || null,
      member_count: memberCount,
      responsible_party_name: responsibleContact.full_name,
      responsible_party_itin: responsibleContact.itin_number || null,
      responsible_party_phone: responsibleContact.phone || null,
      responsible_party_title: title,
      language: responsibleContact.language === "Italian" ? "it" : "en",
      county_and_state: resolvedCountyAndState, // null if RA address unknown — admin must fix RA + ss4_update before signing
      status: "draft",
    })
    .select("id, token, access_code, status")
    .single()

  if (insertErr || !ss4) {
    return { error: `Insert failed: ${insertErr?.message || "insert failed"}` }
  }

  logAction({
    actor: "crm-admin",
    action_type: "create",
    table_name: "ss4_applications",
    record_id: ss4.id,
    account_id: accountId,
    summary: `Created SS-4 application for ${account.company_name} (${entityType}, ${state})`,
    details: { token: ss4.token, entity_type: entityType, state, source: "crm-button" },
  })

  return {
    success: true,
    token: ss4.token,
    access_code: ss4.access_code,
    admin_preview: `${SS4_BASE_URL}/${ss4.token}/${ss4.access_code}?preview=td`,
    entity_type: entityType,
    company_name: account.company_name,
  }
}

// ─── Send OA ───

async function sendOA(token: string) {
  const { data: oa, error } = await supabaseAdmin
    .from("oa_agreements")
    .select("id, token, status, member_email, company_name, access_code, account_id")
    .eq("token", token)
    .single()

  if (error || !oa) return { error: `OA not found: ${token}` }
  if (!oa.member_email) return { error: "No member email on OA record" }
  if (oa.status === "sent" || oa.status === "signed") return { already_sent: true, status: oa.status }

  // Update status to sent (the actual email sending is done by MCP oa_send which uses Gmail API)
  // For CRM, we mark as sent and let the admin know to use MCP or the external page handles it
  const { error: updateErr } = await supabaseAdmin
    .from("oa_agreements")
    .update({ status: "sent" })
    .eq("id", oa.id)

  if (updateErr) return { error: `Failed to update OA status: ${updateErr.message}` }

  logAction({
    actor: "crm-admin",
    action_type: "send",
    table_name: "oa_agreements",
    record_id: oa.id,
    account_id: oa.account_id,
    summary: `Sent OA to ${oa.member_email} for ${oa.company_name}`,
    details: { token: oa.token, email: oa.member_email, source: "crm-button" },
  })

  return {
    success: true,
    sent_to: oa.member_email,
    client_url: `${OA_BASE_URL}/${oa.token}/${oa.access_code}`,
  }
}

// ─── Send Lease ───

async function sendLease(token: string) {
  const { data: lease, error } = await supabaseAdmin
    .from("lease_agreements")
    .select("id, token, status, tenant_email, tenant_company, access_code, account_id")
    .eq("token", token)
    .single()

  if (error || !lease) return { error: `Lease not found: ${token}` }
  if (!lease.tenant_email) return { error: "No tenant email on lease record" }
  if (lease.status === "sent" || lease.status === "signed" || lease.status === "active") {
    return { already_sent: true, status: lease.status }
  }

  const { error: updateErr } = await supabaseAdmin
    .from("lease_agreements")
    .update({ status: "sent" })
    .eq("id", lease.id)

  if (updateErr) return { error: `Failed to update lease status: ${updateErr.message}` }

  logAction({
    actor: "crm-admin",
    action_type: "send",
    table_name: "lease_agreements",
    record_id: lease.id,
    account_id: lease.account_id,
    summary: `Sent lease to ${lease.tenant_email} for ${lease.tenant_company}`,
    details: { token: lease.token, email: lease.tenant_email, source: "crm-button" },
  })

  return {
    success: true,
    sent_to: lease.tenant_email,
    client_url: `${LEASE_BASE_URL}/${lease.token}/${lease.access_code}`,
  }
}

// ─── Fetch Document Statuses ───

async function fetchDocumentStatuses(accountId: string) {
  const year = new Date().getFullYear()

  const [oaResult, leaseResult, ss4Result, relayResult, paysetResult] = await Promise.all([
    supabaseAdmin.from("oa_agreements").select("id, token, status, access_code, signed_at, created_at").eq("account_id", accountId).limit(1),
    supabaseAdmin.from("lease_agreements").select("id, token, status, access_code, suite_number, signed_at, created_at, contract_year, term_start_date, term_end_date").eq("account_id", accountId).eq("contract_year", year).limit(1),
    supabaseAdmin.from("ss4_applications").select("id, token, status, access_code, signed_at, created_at").eq("account_id", accountId).limit(1),
    supabaseAdmin.from("banking_submissions").select("id, token, status, created_at").eq("account_id", accountId).eq("provider", "relay").limit(1),
    supabaseAdmin.from("banking_submissions").select("id, token, status, created_at").eq("account_id", accountId).eq("provider", "payset").limit(1),
  ])

  return {
    oa: oaResult.data?.[0] || null,
    lease: leaseResult.data?.[0] || null,
    ss4: ss4Result.data?.[0] || null,
    relay: relayResult.data?.[0] || null,
    payset: paysetResult.data?.[0] || null,
  }
}

// ─── Main Route ───

export async function POST(request: Request) {
  try {
    // Permission check — all document generation is admin-only
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, "generate_oa")) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    const body = await request.json()
    const { action, account_id, ...params } = body

    if (!action) {
      return NextResponse.json({ error: "Missing 'action' field" }, { status: 400 })
    }

    switch (action) {
      case "generate_oa": {
        if (!account_id) return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
        const result = await generateOA(account_id, params)
        if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })
        if ("exists" in result) return NextResponse.json({ error: `OA already exists (token: ${result.token}, status: ${result.status})`, exists: true, token: result.token, status: result.status, effective_date: (result as Record<string, unknown>).effective_date }, { status: 409 })
        return NextResponse.json(result)
      }

      case "generate_lease": {
        if (!account_id) return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
        const result = await generateLease(account_id, params)
        if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })
        if ("exists" in result) return NextResponse.json({ error: `Lease already exists (token: ${result.token}, status: ${result.status})`, exists: true, token: result.token, status: result.status }, { status: 409 })
        return NextResponse.json(result)
      }

      case "generate_ss4": {
        if (!account_id) return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
        const result = await generateSS4(account_id, { regenerate: params.regenerate === true })
        if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })
        if ("exists" in result) return NextResponse.json({ error: `SS-4 already exists (token: ${result.token}, status: ${result.status}). Use Regenerate to refresh an unsigned SS-4 from the account's current data.`, exists: true, token: result.token, status: result.status }, { status: 409 })
        return NextResponse.json(result)
      }

      case "send_oa": {
        if (!params.token) return NextResponse.json({ error: "Missing token" }, { status: 400 })
        const result = await sendOA(params.token)
        if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })
        if ("already_sent" in result) return NextResponse.json({ message: `Already ${result.status}`, status: result.status })
        return NextResponse.json(result)
      }

      case "send_lease": {
        if (!params.token) return NextResponse.json({ error: "Missing token" }, { status: 400 })
        const result = await sendLease(params.token)
        if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })
        if ("already_sent" in result) return NextResponse.json({ message: `Already ${result.status}`, status: result.status })
        return NextResponse.json(result)
      }

      case "fetch_statuses": {
        if (!account_id) return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
        const statuses = await fetchDocumentStatuses(account_id)
        return NextResponse.json(statuses)
      }

      case "generate_welcome_package": {
        if (!account_id) return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
        const suiteNumber = params.suite_number as string

        const results: Record<string, unknown> = {}
        const errors: string[] = []

        // Generate OA if missing
        const oaResult = await generateOA(account_id, params)
        if ("error" in oaResult) errors.push(`OA: ${oaResult.error}`)
        else if ("exists" in oaResult) results.oa = { skipped: true, token: oaResult.token, status: oaResult.status }
        else results.oa = oaResult

        // Generate Lease if missing (need suite number)
        if (suiteNumber) {
          const leaseResult = await generateLease(account_id, { suite_number: suiteNumber })
          if ("error" in leaseResult) errors.push(`Lease: ${leaseResult.error}`)
          else if ("exists" in leaseResult) results.lease = { skipped: true, token: leaseResult.token, status: leaseResult.status }
          else results.lease = leaseResult
        } else {
          errors.push("Lease: Suite number required")
        }

        // Generate SS-4 if missing
        const ss4Result = await generateSS4(account_id)
        if ("error" in ss4Result) errors.push(`SS-4: ${ss4Result.error}`)
        else if ("exists" in ss4Result) results.ss4 = { skipped: true, token: ss4Result.token, status: ss4Result.status }
        else results.ss4 = ss4Result

        logAction({
          actor: "crm-admin",
          action_type: "create",
          table_name: "accounts",
          record_id: account_id,
          account_id,
          summary: `Generated welcome package (${Object.keys(results).length} docs created/found, ${errors.length} errors)`,
          details: { results, errors, source: "crm-button" },
        })

        return NextResponse.json({
          success: errors.length === 0,
          results,
          errors: errors.length > 0 ? errors : undefined,
        })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    console.error("generate-document error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "An unexpected error occurred" },
      { status: 500 }
    )
  }
}
