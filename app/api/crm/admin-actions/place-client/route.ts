/**
 * Admin Action: Place Client
 *
 * POST /api/crm/admin-actions/place-client
 *
 * Places a legacy client (or any account) at the correct pipeline stage,
 * creating any missing resources (Drive folder, SD, OA, Lease, Banking forms,
 * Tax Return record). Every step is idempotent — running twice skips what exists.
 *
 * Body:
 *   account_id: string (UUID)
 *   stage: string (one of the STAGE_PRESETS keys)
 *   actions: object — which resources to create (each boolean)
 *   suite_number?: string — required if actions.lease is true
 *   reason: string — why this placement is happening
 */

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
// createFolder removed — now uses ensureCompanyFolder from drive-folder-utils
import { createClient } from "@/lib/supabase/server"
import { canPerform } from "@/lib/permissions"
import { isMultiMemberEntity } from "@/lib/portal/entity-type"
import { hasCollectedSignatures } from "@/lib/portal/oa-regenerate-guard"
import { OA_SUPPORTED_STATES } from "@/lib/types/oa-templates"

// ─── Types ───

interface PlaceClientRequest {
  account_id: string
  stage: string
  actions: {
    drive_folder?: boolean
    service_delivery?: boolean
    oa?: boolean
    lease?: boolean
    banking_relay?: boolean
    banking_payset?: boolean
    tax_return?: boolean
    portal_tier?: boolean
  }
  suite_number?: string
  service_type?: string // e.g. "Company Formation", "Client Onboarding"
  reason: string
}

interface StepResult {
  name: string
  status: "ok" | "skipped" | "error"
  detail: string
}

// ─── Stage presets — maps user selection to pipeline data ───

const STAGE_PRESETS: Record<string, { service_type: string; stage_name: string; stage_order: number; portal_tier: string }> = {
  // Company Formation — mapped to the 8-stage v2 pipeline
  // (migration 20260629-1000-ss4-sent-to-irs-stage.sql adds SS-4 Sent to IRS at
  // order 7; EIN Received moved to order 8). stage_order must match the
  // catalog row's order so createServiceDelivery resolves the right auto_tasks.
  just_paid: {
    service_type: "Company Formation",
    stage_name: "Payment Confirmed",
    stage_order: 1,
    portal_tier: "formation",
  },
  data_collected: {
    service_type: "Company Formation",
    stage_name: "Wizard Submitted",
    stage_order: 2,
    portal_tier: "formation",
  },
  llc_formed: {
    service_type: "Company Formation",
    stage_name: "Articles Received",
    stage_order: 4,
    portal_tier: "formation",
  },
  ein_received: {
    service_type: "Company Formation",
    stage_name: "EIN Received",
    stage_order: 8,
    portal_tier: "active",
  },
  everything_done: {
    service_type: "Company Formation",
    stage_name: "EIN Received",
    stage_order: 8,
    portal_tier: "active",
  },
  onboarding_data_collection: {
    service_type: "Client Onboarding",
    stage_name: "Data Collection",
    stage_order: 1,
    portal_tier: "onboarding",
  },
  onboarding_review: {
    service_type: "Client Onboarding",
    stage_name: "Review & CRM Setup",
    stage_order: 2,
    portal_tier: "onboarding",
  },
  onboarding_complete: {
    service_type: "Client Onboarding",
    stage_name: "Post-Review & Closing",
    stage_order: 3,
    portal_tier: "active",
  },
}

// ─── State folder map for Google Drive ───

// STATE_FOLDER_MAP and COMPANIES_ROOT_ID removed — now centralized in drive-folder-utils.ts

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

// ─── Individual Step Handlers ───

async function createDriveFolder(
  accountId: string,
  companyName: string,
  state: string,
  contactName: string | null,
): Promise<StepResult> {
  try {
    const { ensureCompanyFolder } = await import("@/lib/drive-folder-utils")
    const result = await ensureCompanyFolder(accountId, companyName, state, contactName || undefined)

    if (result.created) {
      return { name: "drive_folder", status: "ok", detail: `Created folder with subfolders (${result.folderId})` }
    }
    return { name: "drive_folder", status: "skipped", detail: `Already exists: ${result.folderId}` }
  } catch (err) {
    return { name: "drive_folder", status: "error", detail: err instanceof Error ? err.message : "Unknown error" }
  }
}

async function createServiceDelivery(
  accountId: string,
  contactId: string,
  serviceType: string,
  stageName: string,
  stageOrder: number,
  companyName: string,
): Promise<StepResult> {
  // Check if SD already exists for this service type + account
  const { data: existing } = await supabaseAdmin
    .from("service_deliveries")
    .select("id, stage, stage_order")
    .eq("account_id", accountId)
    .eq("service_type", serviceType)
    .eq("status", "active")
    .limit(1)

  if (existing?.length) {
    return {
      name: "service_delivery",
      status: "skipped",
      detail: `Active ${serviceType} SD already exists at stage "${existing[0].stage}" (order ${existing[0].stage_order})`,
    }
  }

  try {
    const serviceName = `${serviceType} - ${companyName}`
    const today = new Date().toISOString().slice(0, 10)

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from("service_deliveries")
      .insert({
        service_name: serviceName,
        service_type: serviceType,
        pipeline: serviceType,
        stage: stageName,
        stage_order: stageOrder,
        account_id: accountId,
        contact_id: contactId,
        status: "active",
        assigned_to: "Luca",
        start_date: today,
        stage_entered_at: new Date().toISOString(),
        stage_history: [{ stage: stageName, stage_order: stageOrder, entered_at: new Date().toISOString(), source: "place-client" }],
      })
      .select("id")
      .single()

    if (sdErr || !sd) {
      return { name: "service_delivery", status: "error", detail: sdErr?.message || "Insert failed" }
    }

    // Create auto-tasks from pipeline_stages
    const { data: pipelineStage } = await supabaseAdmin
      .from("pipeline_stages")
      .select("auto_tasks")
      .eq("service_type", serviceType)
      .eq("stage_order", stageOrder)
      .single()

    let tasksCreated = 0
    if (pipelineStage?.auto_tasks && Array.isArray(pipelineStage.auto_tasks)) {
      for (const rawTask of pipelineStage.auto_tasks) {
        const taskDef = rawTask as Record<string, unknown>
        const title = (taskDef.title as string) || (taskDef.task as string)
        if (!title) continue
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        await supabaseAdmin.from("tasks").insert({
          task_title: title,
          assigned_to: (taskDef.assigned_to as string) || "Luca",
          category: ((taskDef.category as string) || "Internal") as never,
          priority: ((taskDef.priority as string) || "Normal") as never,
          status: "To Do",
          account_id: accountId,
          delivery_id: sd.id,
          stage_order: stageOrder,
        })
        tasksCreated++
      }
    }

    return {
      name: "service_delivery",
      status: "ok",
      detail: `Created ${serviceType} SD at "${stageName}" (stage ${stageOrder}) + ${tasksCreated} auto-tasks`,
    }
  } catch (err) {
    return { name: "service_delivery", status: "error", detail: err instanceof Error ? err.message : "Unknown error" }
  }
}

async function createOA(
  accountId: string,
  account: { company_name: string; state_of_formation: string | null; entity_type: string | null; member_structure: string | null; formation_date: string | null; ein_number: string | null },
): Promise<StepResult> {
  // Check if OA exists. Ordered — PostgREST returns an ARBITRARY row without
  // it, and on an account with more than one OA row this must find the same
  // one every other reader (oa_get, /portal/sign) treats as current.
  const { data: existing } = await supabaseAdmin
    .from("oa_agreements")
    .select("id, token, status")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(1)

  if (existing?.length) {
    return { name: "oa", status: "skipped", detail: `OA already exists (${existing[0].token}, status: ${existing[0].status})` }
  }

  const rawState = (account.state_of_formation || "").toUpperCase().trim()
  const state = STATE_MAP[rawState] || rawState
  if (!OA_SUPPORTED_STATES.includes(state as typeof OA_SUPPORTED_STATES[number])) {
    return { name: "oa", status: "error", detail: `State "${account.state_of_formation}" not supported for OA. Supported: ${OA_SUPPORTED_STATES.join(", ")}` }
  }
  const rawEntity = (account.entity_type || "").toUpperCase().trim()
  // isMultiMemberEntity checked FIRST — MUST match resolveAccountSigner's own
  // precedence (lib/members/resolve-signer.ts), which also checks it first.
  // An earlier version of this line checked Corporation-detection first,
  // which meant an account with entity_type text matching "CORPORATION" AND
  // member_structure='multi_member' would resolve its SIGNER via the MMLLC
  // rule (resolveAccountSigner) while this function built the DOCUMENT as
  // single-signer "Corporation" — the two paths silently disagreeing on the
  // same account (Bug-Hunter, dev job 9ad76300-6181-4250-a1de-c77f37933f82, third pass).
  const entityType = isMultiMemberEntity(account.entity_type, account.member_structure)
    ? "MMLLC"
    : (ENTITY_MAP[rawEntity] === "Corporation" ? "Corporation" : "SMLLC")

  // Who the document names as Manager/Member — from the members table's
  // flagged signer, not from the account's first linked contact. Dev job
  // 9ad76300-6181-4250-a1de-c77f37933f82.
  const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
  const signerResolution = await resolveAccountSigner(accountId)
  if (signerResolution.outcome !== "resolved") {
    return { name: "oa", status: "error", detail: signerResolution.message }
  }
  const signerContact = signerResolution.contact

  // For MMLLC, build members from the CRM members table — the single source
  // of truth for ownership. Never fabricate percentages (Datavora incident,
  // 2026-05-25). Mirrors generate-document/route.ts::generateOA — this
  // function had NO roster-building at all before dev job 9ad76300-6181-4250-a1de-c77f37933f82 (second
  // pass): every multi-member company placed through this route got an OA
  // stored as a one-signer document, with the other real owners never given
  // a signature row to sign at all.
  let membersJson: Array<{ name: string; email: string | null; address: string | null; ownership_pct: number; initial_contribution: string }> | null = null
  let signerSeeds: Array<{ name: string; email: string | null; contact_id: string | null }> = []
  if (entityType === "MMLLC") {
    const { data: memberRows } = await supabaseAdmin
      .from("members")
      .select("full_name, company_name, email, ownership_pct, member_type, contact_id, address_street, address_city, address_state, address_zip, address_country")
      .eq("account_id", accountId)
      .order("is_primary", { ascending: false })

    if (!memberRows?.length) {
      return { name: "oa", status: "error", detail: `"${account.company_name}" is a Multi Member LLC but has no rows in its Members section. Add the members with their real ownership percentages first.` }
    }

    const ownershipTotal = memberRows.reduce((s, m) => s + (Number(m.ownership_pct) || 0), 0)
    if (Math.abs(ownershipTotal - 100) > 0.01) {
      return { name: "oa", status: "error", detail: `Members ownership for "${account.company_name}" totals ${ownershipTotal}% — it must total 100%. Fix the Members section first.` }
    }

    const contactIds = memberRows.map(m => m.contact_id).filter((id): id is string => !!id)
    const { data: memberContacts } = contactIds.length
      ? await supabaseAdmin.from("contacts").select("id, residency, email").in("id", contactIds)
      : { data: [] as Array<{ id: string; residency: string | null; email: string | null }> }
    const contactById = new Map((memberContacts ?? []).map(c => [c.id, c]))

    membersJson = memberRows.map(m => {
      const c = m.contact_id ? contactById.get(m.contact_id) : undefined
      const memberAddress = [m.address_street, m.address_city, m.address_state, m.address_zip, m.address_country].filter(Boolean).join(", ")
      return {
        name: m.full_name ?? m.company_name ?? "Unknown",
        email: m.email ?? c?.email ?? null,
        address: memberAddress || c?.residency || null,
        ownership_pct: Number(m.ownership_pct),
        initial_contribution: "$0.00",
      }
    })

    signerSeeds = memberRows.map(m => {
      const c = m.contact_id ? contactById.get(m.contact_id) : undefined
      return {
        name: m.full_name ?? m.company_name ?? "Unknown",
        email: m.email ?? c?.email ?? null,
        contact_id: m.contact_id ?? null,
      }
    })
  }

  try {
    const year = new Date().getFullYear()
    const token = `${slugify(account.company_name)}-oa-${year}`
    const today = new Date().toISOString().slice(0, 10)

    const { data: oa, error: insertErr } = await supabaseAdmin
      .from("oa_agreements")
      .insert({
        token,
        account_id: accountId,
        contact_id: signerContact.id,
        company_name: account.company_name,
        state_of_formation: state,
        formation_date: account.formation_date || today,
        ein_number: account.ein_number || null,
        entity_type: entityType,
        manager_name: signerContact.full_name,
        member_name: signerContact.full_name,
        member_address: signerContact.residency || null,
        member_email: signerContact.email || null,
        members: membersJson,
        effective_date: today,
        business_purpose: "any and all lawful business activities",
        initial_contribution: "$0.00",
        fiscal_year_end: "December 31",
        accounting_method: "Cash",
        duration: "Perpetual",
        principal_address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
        language: "en",
        status: "draft",
        // Load-bearing: the whole system decides "multi-member" from
        // entity_type AND this count. Leaving it at the default of 1 makes a
        // multi-member agreement render and file as a single-member one.
        total_signers: entityType === "MMLLC" ? Math.max(signerSeeds.length, 1) : 1,
      })
      .select("id, token")
      .single()

    if (insertErr || !oa) {
      return { name: "oa", status: "error", detail: insertErr?.message || "Insert failed" }
    }

    // One signature row per member, or nobody can sign. Roll back rather than
    // leave a half-built, unsignable agreement in place.
    if (entityType === "MMLLC" && signerSeeds.length) {
      const { error: sigErr } = await supabaseAdmin.from("oa_signatures").insert(
        signerSeeds.map((s, idx) => ({
          oa_id: oa.id,
          member_index: idx,
          member_name: s.name,
          member_email: s.email,
          contact_id: s.contact_id,
        })),
      )
      if (sigErr) {
        // Every oa_agreements hard-delete site must go through the shared
        // guard (R100 / tests/unit/oa-regenerate-guard.test.ts) — this row
        // is a fresh insert from this same call with no window to have been
        // signed, but re-reading and checking rather than assuming keeps
        // that true even under a hypothetical race. FAIL CLOSED: a failed
        // re-read is NOT treated as "safe to delete" — a discarded error on
        // the read used to fall into the same branch as a genuine unsigned
        // row, so a read failure alone was previously enough to justify
        // deleting the agreement.
        const { data: freshOa, error: freshOaErr } = await supabaseAdmin.from("oa_agreements").select("status, signed_count").eq("id", oa.id).maybeSingle()
        if (!freshOaErr && freshOa && !hasCollectedSignatures(freshOa)) {
          await supabaseAdmin.from("oa_signatures").delete().eq("oa_id", oa.id)
          await supabaseAdmin.from("oa_agreements").delete().eq("id", oa.id)
          return { name: "oa", status: "error", detail: `Could not create the member signature rows: ${sigErr.message}. Nothing was saved — please try again.` }
        }
        return { name: "oa", status: "error", detail: `Could not create the member signature rows: ${sigErr.message}. The incomplete draft OA record could not be safely verified for removal and was left in place — have staff check account ${accountId}'s Operating Agreement before retrying.` }
      }
    }

    return { name: "oa", status: "ok", detail: `Created OA draft (${oa.token})` }
  } catch (err) {
    return { name: "oa", status: "error", detail: err instanceof Error ? err.message : "Unknown error" }
  }
}

async function createLeaseForPlacement(
  accountId: string,
  suiteNumber: string,
): Promise<StepResult> {
  // No explicit contact_id — createLease resolves the tenant/signer itself
  // from the account's members table (is_signer flag), not from the generic
  // first-linked-contact used elsewhere in this route for OA/Drive/SD
  // purposes, which is the wrong source for a Multi-Member LLC's signer.
  const { createLease } = await import("@/lib/operations/lease")
  const result = await createLease({
    account_id: accountId,
    suite_number: suiteNumber,
    actor: "crm-admin:place-client",
    summary: `Created lease during Place Client flow (Suite ${suiteNumber})`,
  })

  if (result.outcome === "duplicate" && result.existing) {
    return { name: "lease", status: "skipped", detail: `Lease already exists (${result.existing.token}, status: ${result.existing.status})` }
  }
  if (!result.success || !result.lease) {
    return { name: "lease", status: "error", detail: result.error || "Insert failed" }
  }
  return { name: "lease", status: "ok", detail: `Created lease draft (${result.lease.token}), Suite ${result.lease.suite_number}` }
}

async function createBankingForm(
  accountId: string,
  provider: "relay" | "payset",
  companyName: string,
  contact: { id: string; full_name: string; email: string | null; phone: string | null; language: string | null },
): Promise<StepResult> {
  // Check if form exists
  const { data: existing } = await supabaseAdmin
    .from("banking_submissions")
    .select("id, token, status")
    .eq("account_id", accountId)
    .eq("provider", provider)
    .limit(1)

  if (existing?.length) {
    return { name: `banking_${provider}`, status: "skipped", detail: `${provider} form already exists (${existing[0].token}, status: ${existing[0].status})` }
  }

  try {
    const slug = slugify(companyName)
    const year = new Date().getFullYear()
    const token = `bank-${slug}-${provider}-${year}`
    const lang = contact.language?.toLowerCase()?.startsWith("it") ? "it" : "en"

    const prefilled = {
      company_name: companyName,
      owner_name: contact.full_name,
      owner_email: contact.email || "",
      owner_phone: contact.phone || "",
    }

    const { data: form, error: insertErr } = await supabaseAdmin
      .from("banking_submissions")
      .insert({
        token,
        account_id: accountId,
        contact_id: contact.id,
        provider,
        language: lang,
        prefilled_data: prefilled,
        status: "created",
      })
      .select("id, token")
      .single()

    if (insertErr || !form) {
      return { name: `banking_${provider}`, status: "error", detail: insertErr?.message || "Insert failed" }
    }

    return { name: `banking_${provider}`, status: "ok", detail: `Created ${provider} banking form (${form.token})` }
  } catch (err) {
    return { name: `banking_${provider}`, status: "error", detail: err instanceof Error ? err.message : "Unknown error" }
  }
}

async function createTaxReturnRecord(
  accountId: string,
  companyName: string,
  entityType: string | null,
  contactName: string,
): Promise<StepResult> {
  const taxYear = new Date().getFullYear() - 1 // current year - 1 for the return being filed

  // Check if tax return exists
  const { data: existing } = await supabaseAdmin
    .from("tax_returns")
    .select("id, status")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .limit(1)

  if (existing?.length) {
    return { name: "tax_return", status: "skipped", detail: `Tax return for ${taxYear} already exists (status: ${existing[0].status})` }
  }

  try {
    const rawEntity = (entityType || "").toUpperCase().trim()
    let returnType = "1120" // default for SMLLC (pro-forma)
    if (rawEntity.includes("MULTI") || rawEntity === "MMLLC") returnType = "1065"
    else if (rawEntity.includes("CORP") || rawEntity === "CORPORATION") returnType = "1120-S"

    const deadline = `${taxYear + 1}-03-15` // March 15 of following year for most LLCs

    // Check if tax return was bundled (included) in the client's offer
    let isBundled = false
    const { data: contactLink } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", accountId)
      .limit(1)
      .maybeSingle()

    if (contactLink?.contact_id) {
      const { data: lead } = await supabaseAdmin
        .from("leads")
        .select("id")
        .eq("converted_to_contact_id", contactLink.contact_id)
        .limit(1)
        .maybeSingle()

      if (lead?.id) {
        const { data: offer } = await supabaseAdmin
          .from("offers")
          .select("services, bundled_pipelines")
          .eq("lead_id", lead.id)
          .in("status", ["completed", "signed", "viewed", "sent"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()

        if (offer?.services && offer?.bundled_pipelines) {
          const pipelines = Array.isArray(offer.bundled_pipelines) ? offer.bundled_pipelines : []
          const services = Array.isArray(offer.services) ? offer.services : []
          if (pipelines.some((p: string) => /tax.return/i.test(p))) {
            const taxService = services.find((s: { pipeline_type?: string; price?: string }) =>
              s.pipeline_type === "Tax Return" &&
              s.price &&
              /inclus[ao]|included|€?\s*0|\$?\s*0/i.test(s.price)
            )
            if (taxService) isBundled = true
          }
        }
      }
    }

    const { data: tr, error: insertErr } = await supabaseAdmin
      .from("tax_returns")
      .insert({
        account_id: accountId,
        company_name: companyName,
        client_name: contactName,
        return_type: returnType as never,
        tax_year: taxYear,
        deadline,
        status: isBundled ? "Paid - Not Started" : "Not Invoiced",
        ...(isBundled ? { paid: true } : {}),
      })
      .select("id")
      .single()

    if (insertErr || !tr) {
      return { name: "tax_return", status: "error", detail: insertErr?.message || "Insert failed" }
    }

    const note = isBundled ? `Created as Paid (bundled in offer)` : `Created (${returnType})`
    return { name: "tax_return", status: "ok", detail: `Tax return ${taxYear}: ${note}` }
  } catch (err) {
    return { name: "tax_return", status: "error", detail: err instanceof Error ? err.message : "Unknown error" }
  }
}

async function setPortalTier(
  accountId: string,
  tier: string,
): Promise<StepResult> {
  try {
    const { syncTier } = await import("@/lib/operations/sync-tier")
    const result = await syncTier({ accountId, newTier: tier as import("@/lib/portal/tier-config").PortalTier, reason: `place-client: set to ${tier}` })

    if (!result.success) {
      return { name: "portal_tier", status: "error", detail: result.error || "Unknown error" }
    }

    if (result.previousTier === tier) {
      return { name: "portal_tier", status: "skipped", detail: `Already at "${tier}" or higher` }
    }

    return { name: "portal_tier", status: "ok", detail: `Set portal tier to "${tier}" (account + contacts synced)` }
  } catch (err) {
    return { name: "portal_tier", status: "error", detail: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── Auto-detect existing resources ───

export async function POST(request: Request) {
  try {
    // Permission check — place client is admin-only
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, "place_client")) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    const body = (await request.json()) as PlaceClientRequest
    const { account_id, stage, actions, suite_number, reason } = body

    if (!account_id) {
      return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
    }
    if (!stage) {
      return NextResponse.json({ error: "Missing stage" }, { status: 400 })
    }
    if (!reason?.trim()) {
      return NextResponse.json({ error: "Reason is required" }, { status: 400 })
    }

    // Resolve stage preset
    const preset = STAGE_PRESETS[stage]
    if (!preset) {
      return NextResponse.json({ error: `Unknown stage: ${stage}. Valid: ${Object.keys(STAGE_PRESETS).join(", ")}` }, { status: 400 })
    }

    // Fetch account + primary contact
    const { data: account, error: accErr } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name, status, ein_number, entity_type, member_structure, state_of_formation, formation_date, drive_folder_id, portal_tier")
      .eq("id", account_id)
      .single()

    if (accErr || !account) {
      return NextResponse.json({ error: `Account not found: ${accErr?.message || "no data"}` }, { status: 400 })
    }

    const { data: contactLinks } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id, role")
      .eq("account_id", account_id)

    if (!contactLinks?.length) {
      return NextResponse.json({ error: `No contacts linked to account "${account.company_name}". Link a contact first.` }, { status: 400 })
    }

    const { data: contact, error: ctErr } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, email, phone, residency, language")
      .eq("id", contactLinks[0].contact_id)
      .single()

    if (ctErr || !contact) {
      return NextResponse.json({ error: `Primary contact not found: ${ctErr?.message || "no data"}` }, { status: 400 })
    }

    // Validate suite_number if lease is requested
    if (actions.lease && !suite_number) {
      return NextResponse.json({ error: "Suite number is required for lease creation" }, { status: 400 })
    }

    // ─── Execute steps ───
    const results: StepResult[] = []

    // 1. Drive folder
    if (actions.drive_folder) {
      const state = account.state_of_formation || "Unknown"
      const r = await createDriveFolder(account_id, account.company_name, state, contact.full_name)
      results.push(r)
    }

    // 2. Service Delivery
    if (actions.service_delivery) {
      const r = await createServiceDelivery(
        account_id,
        contact.id,
        body.service_type || preset.service_type,
        preset.stage_name,
        preset.stage_order,
        account.company_name,
      )
      results.push(r)
    }

    // 3. OA
    if (actions.oa) {
      const r = await createOA(account_id, account)
      results.push(r)
    }

    // 4. Lease
    if (actions.lease && suite_number) {
      const r = await createLeaseForPlacement(account_id, suite_number)
      results.push(r)
    }

    // 5. Banking Relay
    if (actions.banking_relay) {
      const r = await createBankingForm(account_id, "relay", account.company_name, contact)
      results.push(r)
    }

    // 6. Banking Payset
    if (actions.banking_payset) {
      const r = await createBankingForm(account_id, "payset", account.company_name, contact)
      results.push(r)
    }

    // 7. Tax Return
    if (actions.tax_return) {
      const r = await createTaxReturnRecord(account_id, account.company_name, account.entity_type, contact.full_name)
      results.push(r)
    }

    // 8. Portal tier
    if (actions.portal_tier) {
      const r = await setPortalTier(account_id, preset.portal_tier)
      results.push(r)
    }

    // 9. Account status — set to Active if LLC is formed (stage 3+) or onboarding
    const activeStages = ["llc_formed", "ein_received", "everything_done", "onboarding_data_collection", "onboarding_review", "onboarding_complete"]
    if (activeStages.includes(stage) && account.status !== "Active") {
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      await supabaseAdmin
        .from("accounts")
        .update({ status: "Active", updated_at: new Date().toISOString() })
        .eq("id", account_id)
      results.push({ name: "account_status", status: "ok", detail: `${account.status} → Active` })
    }

    // Summarize
    const okCount = results.filter(r => r.status === "ok").length
    const skippedCount = results.filter(r => r.status === "skipped").length
    const errorCount = results.filter(r => r.status === "error").length

    logAction({
      actor: "crm-admin",
      action_type: "create",
      table_name: "accounts",
      record_id: account_id,
      account_id,
      summary: `Place Client: ${account.company_name} at "${preset.stage_name}" (${preset.service_type}). ${okCount} created, ${skippedCount} skipped, ${errorCount} errors. Reason: ${reason}`,
      details: { stage, preset, actions, results, reason, source: "crm-button" },
    })

    return NextResponse.json({
      success: errorCount === 0,
      results,
      summary: { ok: okCount, skipped: skippedCount, errors: errorCount },
      stage_info: preset,
    })
  } catch (err) {
    console.error("place-client error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "An unexpected error occurred" },
      { status: 500 },
    )
  }
}

// ─── Auto-detect: GET returns what exists vs what's missing ───

export async function GET(request: Request) {
  try {
    // Permission check — detect is also admin-only
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, "place_client")) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const accountId = searchParams.get("account_id")

    if (!accountId) {
      return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
    }

    const year = new Date().getFullYear()
    const taxYear = year - 1

    const [acctResult, contactResult, sdResult, oaResult, leaseResult, relayResult, paysetResult, taxResult] = await Promise.all([
      supabaseAdmin.from("accounts").select("id, drive_folder_id, portal_tier, company_name, state_of_formation, entity_type, ein_number, formation_date").eq("id", accountId).single(),
      supabaseAdmin.from("account_contacts").select("contact_id, role, contact:contacts(id, full_name, email)").eq("account_id", accountId),
      supabaseAdmin.from("service_deliveries").select("id, service_type, stage, stage_order, status").eq("account_id", accountId).eq("status", "active"),
      supabaseAdmin.from("oa_agreements").select("id, token, status").eq("account_id", accountId).limit(1),
      supabaseAdmin.from("lease_agreements").select("id, token, status, suite_number").eq("account_id", accountId).eq("contract_year", year).limit(1),
      supabaseAdmin.from("banking_submissions").select("id, token, status").eq("account_id", accountId).eq("provider", "relay").limit(1),
      supabaseAdmin.from("banking_submissions").select("id, token, status").eq("account_id", accountId).eq("provider", "payset").limit(1),
      supabaseAdmin.from("tax_returns").select("id, status, tax_year").eq("account_id", accountId).eq("tax_year", taxYear).limit(1),
    ])

    const account = acctResult.data
    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 })
    }

    return NextResponse.json({
      account: {
        company_name: account.company_name,
        state_of_formation: account.state_of_formation,
        entity_type: account.entity_type,
        ein_number: account.ein_number,
        formation_date: account.formation_date,
      },
      contacts: (contactResult.data || []).map(c => ({
        contact_id: c.contact_id,
        role: c.role,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        full_name: (c.contact as any)?.full_name || "Unknown",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        email: (c.contact as any)?.email || null,
      })),
      existing: {
        drive_folder: !!account.drive_folder_id,
        service_deliveries: (sdResult.data || []).map(sd => ({
          service_type: sd.service_type,
          stage: sd.stage,
          stage_order: sd.stage_order,
        })),
        oa: oaResult.data?.[0] ? { token: oaResult.data[0].token, status: oaResult.data[0].status } : null,
        lease: leaseResult.data?.[0] ? { token: leaseResult.data[0].token, status: leaseResult.data[0].status, suite_number: leaseResult.data[0].suite_number } : null,
        banking_relay: relayResult.data?.[0] ? { token: relayResult.data[0].token, status: relayResult.data[0].status } : null,
        banking_payset: paysetResult.data?.[0] ? { token: paysetResult.data[0].token, status: paysetResult.data[0].status } : null,
        tax_return: taxResult.data?.[0] ? { tax_year: taxResult.data[0].tax_year, status: taxResult.data[0].status } : null,
        portal_tier: account.portal_tier || null,
      },
    })
  } catch (err) {
    console.error("place-client detect error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "An unexpected error occurred" },
      { status: 500 },
    )
  }
}
