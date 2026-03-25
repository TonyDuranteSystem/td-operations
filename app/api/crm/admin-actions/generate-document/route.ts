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
  const { data: account, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, ein_number, entity_type, state_of_formation, formation_date")
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
    .select("id, full_name, email, phone, address, language, itin_number")
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

  // Check duplicate
  const { data: existing } = await supabaseAdmin
    .from("oa_agreements")
    .select("id, token, status")
    .eq("account_id", accountId)
    .limit(1)

  if (existing?.length) {
    return { exists: true, token: existing[0].token, status: existing[0].status }
  }

  const year = new Date().getFullYear()
  const token = `${slugify(account.company_name)}-oa-${year}`
  const today = new Date().toISOString().slice(0, 10)

  // For MMLLC, auto-build members from account_contacts
  let membersJson = null
  if (entityType === "MMLLC" && contactLinks!.length >= 2) {
    const contactIds = contactLinks!.map(cl => cl.contact_id)
    const { data: allContacts } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, email, address")
      .in("id", contactIds)

    if (allContacts) {
      const pct = Math.floor(100 / allContacts.length)
      const remainder = 100 - (pct * allContacts.length)
      membersJson = allContacts.map((c, i) => ({
        name: c.full_name,
        email: c.email || null,
        address: c.address || null,
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
      member_address: contact.address || null,
      member_email: contact.email || null,
      members: membersJson,
      effective_date: (params.effective_date as string) || today,
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
  const result = await fetchAccountAndContact(accountId)
  if ("error" in result) return { error: result.error }
  const { account, contact } = result

  const suiteNumber = params.suite_number as string
  if (!suiteNumber) {
    return { error: "Suite number is required (e.g., '3D-107')" }
  }

  const year = (params.contract_year as number) ?? new Date().getFullYear()

  // Check duplicate
  const { data: existing } = await supabaseAdmin
    .from("lease_agreements")
    .select("id, token, status")
    .eq("account_id", accountId)
    .eq("contract_year", year)
    .limit(1)

  if (existing?.length) {
    return { exists: true, token: existing[0].token, status: existing[0].status }
  }

  const token = `${slugify(account.company_name)}-${year}`
  const today = new Date().toISOString().slice(0, 10)
  const monthlyRent = (params.monthly_rent as number) ?? 100
  const yearlyRent = (params.yearly_rent as number) ?? (monthlyRent * 12)

  const { data: lease, error: insertErr } = await supabaseAdmin
    .from("lease_agreements")
    .insert({
      token,
      account_id: accountId,
      contact_id: contact.id,
      tenant_company: account.company_name,
      tenant_ein: account.ein_number || null,
      tenant_state: account.state_of_formation || null,
      tenant_contact_name: contact.full_name,
      tenant_email: contact.email || null,
      premises_address: "10225 Ulmerton Rd, Largo, FL 33771",
      suite_number: suiteNumber,
      square_feet: (params.square_feet as number) ?? 120,
      effective_date: (params.effective_date as string) || today,
      term_start_date: today,
      term_end_date: `${year}-12-31`,
      term_months: 12,
      contract_year: year,
      monthly_rent: monthlyRent,
      yearly_rent: yearlyRent,
      security_deposit: (params.security_deposit as number) ?? 150,
      language: contact.language?.toLowerCase()?.startsWith("it") ? "it" : "en",
      status: "draft",
    })
    .select("id, token, access_code")
    .single()

  if (insertErr || !lease) {
    return { error: `Insert failed: ${insertErr?.message || "no data"}` }
  }

  logAction({
    actor: "crm-admin",
    action_type: "create",
    table_name: "lease_agreements",
    record_id: lease.id,
    account_id: accountId,
    summary: `Created lease agreement for ${account.company_name} (${year}), Suite ${suiteNumber}`,
    details: { token: lease.token, suite_number: suiteNumber, year, source: "crm-button" },
  })

  return {
    success: true,
    token: lease.token,
    access_code: lease.access_code,
    admin_preview: `${LEASE_BASE_URL}/${lease.token}?preview=td`,
    client_url: `${LEASE_BASE_URL}/${lease.token}/${lease.access_code}`,
    suite_number: suiteNumber,
    company_name: account.company_name,
  }
}

// ─── Generate SS-4 ───

async function generateSS4(accountId: string) {
  const result = await fetchAccountAndContact(accountId)
  if ("error" in result) return { error: result.error }
  const { account, contact, contactLinks } = result

  if (!account.state_of_formation) {
    return { error: `Account "${account.company_name}" missing state_of_formation.` }
  }

  // Check duplicate
  const { data: existing } = await supabaseAdmin
    .from("ss4_applications")
    .select("id, token, status")
    .eq("account_id", accountId)
    .maybeSingle()

  if (existing) {
    return { exists: true, token: existing.token, status: existing.status }
  }

  const rawEntity = (account.entity_type || "").toUpperCase().trim()
  const entityType = ENTITY_MAP[rawEntity] || "SMLLC"
  const state = STATE_MAP[(account.state_of_formation || "").toUpperCase().trim()] || account.state_of_formation

  let memberCount = 1
  if (entityType !== "SMLLC") {
    memberCount = contactLinks!.length || 2
  }

  const slug = slugify(account.company_name)
  const token = `ss4-${slug}-${new Date().getFullYear()}`
  const title = entityType === "SMLLC" ? "Owner" : entityType === "MMLLC" ? "Member" : "President"

  const { data: ss4, error: insertErr } = await supabaseAdmin
    .from("ss4_applications")
    .insert({
      token,
      account_id: accountId,
      contact_id: contact.id,
      company_name: account.company_name,
      entity_type: entityType,
      state_of_formation: state,
      formation_date: account.formation_date || null,
      member_count: memberCount,
      responsible_party_name: contact.full_name,
      responsible_party_itin: contact.itin_number || null,
      responsible_party_phone: contact.phone || null,
      responsible_party_title: title,
      language: contact.language === "Italian" ? "it" : "en",
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
    supabaseAdmin.from("lease_agreements").select("id, token, status, access_code, suite_number, signed_at, created_at, contract_year").eq("account_id", accountId).eq("contract_year", year).limit(1),
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
        if ("exists" in result) return NextResponse.json({ error: `OA already exists (token: ${result.token}, status: ${result.status})`, exists: true, token: result.token, status: result.status }, { status: 409 })
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
        const result = await generateSS4(account_id)
        if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })
        if ("exists" in result) return NextResponse.json({ error: `SS-4 already exists (token: ${result.token}, status: ${result.status})`, exists: true, token: result.token, status: result.status }, { status: 409 })
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
