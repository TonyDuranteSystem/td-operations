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
import { decideSs4Signer, ss4SignerAlertMessage, pickDefaultSs4SignerLink, type Ss4SignerMember } from "@/lib/operations/ss4-signer"
import { refreshSS4 } from "@/lib/operations/ss4-refresh"
import { hasCollectedSignatures } from "@/lib/portal/oa-regenerate-guard"

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
  const { account, contact } = result

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

  // Check duplicate. ORDER matters: without it PostgREST returns an ARBITRARY
  // row, while oa_get and /portal/sign both read the NEWEST — so Recreate could
  // delete a different agreement than the one staff are looking at. Same trap
  // already closed in lib/mcp/tools/oa.ts.
  const { data: existing } = await supabaseAdmin
    .from("oa_agreements")
    .select("id, token, status, effective_date, signed_count")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(1)

  if (existing?.length && !params.force_recreate) {
    return { exists: true, token: existing[0].token, status: existing[0].status, effective_date: existing[0].effective_date }
  }

  // ⛔ THE THIRD DOOR. force_recreate hard-deletes the agreement AND every
  // signature on it — no soft-delete, no audit record (R100). That is only safe
  // while NOTHING has been signed. The shared rule was wired into the portal
  // route and the MCP tool but NOT here, leaving a two-click path in the CRM
  // that destroys an executed legal document and the only proof the client ever
  // signed it. Same predicate as both other doors — one rule, three doors.
  // Defence in depth, matching the portal door: the parent row's status/count can
  // lag a signature that IS already written (the signing route writes the member's
  // row and only then increments the counter). Ask the signatures themselves too,
  // and FAIL CLOSED if that count cannot be read — refusing a re-create is
  // recoverable, deleting an executed signature is not.
  if (existing?.length && params.force_recreate) {
    const { count: signedChildren, error: countErr } = await supabaseAdmin
      .from("oa_signatures")
      .select("id", { count: "exact", head: true })
      .eq("oa_id", existing[0].id)
      .eq("status", "signed")
    if (countErr) {
      return { error: `Could not verify whether this Operating Agreement has been signed, so it was not touched. Please try again.` }
    }
    if ((signedChildren ?? 0) > 0) {
      return {
        error:
          `Refusing to recreate: ${signedChildren} member signature(s) are already recorded on this ` +
          `Operating Agreement. Recreating deletes them with no undo. VOID it instead, then create a new one.`,
      }
    }
  }

  if (existing?.length && params.force_recreate && hasCollectedSignatures(existing[0])) {
    const collected = (existing[0].signed_count ?? 0) > 0 ? ` (${existing[0].signed_count} signature(s) collected)` : ""
    return {
      error:
        `Refusing to recreate: this Operating Agreement already carries a signature ` +
        `(status: ${existing[0].status}${collected}). Recreating deletes the agreement and every ` +
        `signature on it, with no undo — destroying the only proof the client signed. ` +
        `VOID the existing agreement instead (which keeps the record), then create a new one.`,
    }
  }

  // force_recreate: delete existing OA (and MMLLC signatures) before recreating
  if (existing?.length && params.force_recreate) {
    await supabaseAdmin.from("oa_signatures").delete().eq("oa_id", existing[0].id)
    const { error: delErr } = await supabaseAdmin.from("oa_agreements").delete().eq("id", existing[0].id)
    if (delErr) return { error: `Failed to delete existing OA: ${delErr.message}` }
  }

  const year = new Date().getFullYear()
  const token = `${slugify(account.company_name)}-oa-${year}`

  // For MMLLC, build members from the CRM members table — the single source of
  // truth for ownership. Never fabricate percentages: an OA with invented
  // splits is a legally incorrect document (Datavora incident, 2026-05-25).
  let membersJson = null
  // Seeds for the per-member signature rows. WITHOUT these (and without
  // total_signers below) a multi-member agreement is stored as a ONE-signer row:
  // every server consumer treats "multi-member" as entity_type AND
  // total_signers > 1, so the draft and the executed PDF both render the
  // SINGLE-member document ("the sole Member ... 100%") while the on-screen page
  // — which keys on entity type alone — shows all the members. The client also
  // cannot e-sign at all, because there is no signer row to resolve them to.
  let signerSeeds: Array<{ name: string; email: string | null; contact_id: string | null }> = []
  if (entityType === "MMLLC") {
    const { data: memberRows } = await supabaseAdmin
      .from("members")
      .select("full_name, company_name, email, ownership_pct, member_type, contact_id, address_street, address_city, address_state, address_zip, address_country")
      .eq("account_id", accountId)
      .order("is_primary", { ascending: false })

    if (!memberRows?.length) {
      return { error: `"${account.company_name}" is a Multi Member LLC but has no rows in its Members section. Add the members with their real ownership percentages first.` }
    }

    const ownershipTotal = memberRows.reduce((s, m) => s + (Number(m.ownership_pct) || 0), 0)
    if (Math.abs(ownershipTotal - 100) > 0.01) {
      return { error: `Members ownership for "${account.company_name}" totals ${ownershipTotal}% — it must total 100%. Fix the Members section first.` }
    }

    // Individual members missing an address on their member row fall back to
    // their contact's residency.
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
      // Load-bearing: the whole system decides "multi-member" from entity_type
      // AND this count. Leaving it at the default of 1 makes a multi-member
      // agreement render and file as a single-member one.
      total_signers: entityType === "MMLLC" ? Math.max(signerSeeds.length, 1) : 1,
    })
    .select("id, token, access_code")
    .single()

  if (insertErr || !oa) {
    return { error: `Insert failed: ${insertErr?.message || "no data"}` }
  }

  // One signature row per member, or nobody can sign: the signing page resolves
  // WHICH member is signing from their per-member code, and with no rows there is
  // no signer to resolve — the client gets a Sign button with nothing to sign.
  // Roll the agreement back rather than leave a half-built one behind.
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
      await supabaseAdmin.from("oa_signatures").delete().eq("oa_id", oa.id)
      await supabaseAdmin.from("oa_agreements").delete().eq("id", oa.id)
      return { error: `Could not create the member signature rows: ${sigErr.message}. Nothing was saved — please try again.` }
    }
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
  const termStartDate = params.term_start_date as string | undefined
  const termEndDate = params.term_end_date as string | undefined
  // When staff pick a start date in the dialog, the lease's contract year is
  // the year of that start date (not "today"). Falls back to any explicit
  // contract_year, else createLease defaults to the current year.
  const contractYear =
    (termStartDate && /^\d{4}-\d{2}-\d{2}$/.test(termStartDate)
      ? Number(termStartDate.slice(0, 4))
      : undefined) ?? (params.contract_year as number | undefined)
  const result = await createLease({
    account_id: accountId,
    suite_number: params.suite_number as string | undefined,
    contract_year: contractYear,
    effective_date: params.effective_date as string | undefined,
    term_start_date: termStartDate,
    term_end_date: termEndDate,
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
  // The refresh itself is the SHARED core (lib/operations/ss4-refresh.ts) —
  // the same implementation behind the flow workspace regenerate and the
  // member-change auto-refresh, so the surfaces can never drift again
  // (2026-07-02 AI Venture Labs incident).
  const { data: existing } = await supabaseAdmin
    .from("ss4_applications")
    .select("id, token, access_code, status, signed_at")
    .eq("account_id", accountId)
    .maybeSingle()

  if (existing && !opts?.regenerate) {
    return { exists: true, token: existing.token, status: existing.status }
  }
  if (existing && opts?.regenerate) {
    const result = await refreshSS4({ account_id: accountId, source: "crm-regenerate" })
    if (result.outcome === "refreshed" || result.outcome === "unchanged") {
      return {
        success: true,
        regenerated: true,
        unchanged: result.outcome === "unchanged",
        token: existing.token,
        access_code: existing.access_code,
        admin_preview: `${SS4_BASE_URL}/${existing.token}/${existing.access_code}?preview=td`,
        entity_type: result.ss4?.entity_type ?? undefined,
        company_name: result.ss4?.company_name ?? account.company_name,
      }
    }
    return { error: result.message || `Could not regenerate the SS-4 (${result.outcome}).` }
  }

  const rawEntity = (account.entity_type || "").toUpperCase().trim()
  const entityType = ENTITY_MAP[rawEntity] || "SMLLC"
  const state = STATE_MAP[(account.state_of_formation || "").toUpperCase().trim()] || account.state_of_formation

  // Responsible-party resolution, in STRICT precedence order (the members
  // decision must always outrank the role hint — final-diff council fix,
  // 2026-08-10; the earlier ordering let an SMLLC role hint out-vote an MMLLC's
  // flagged signer):
  //   1. Non-SMLLC with members rows → decideSs4Signer (flagged signer, or
  //      BLOCK with the staff alert) — same rule createSS4 enforces.
  //   2. Otherwise (SMLLC, or no members rows) → pickDefaultSs4SignerLink over
  //      the account_contacts roles (never blocks; the ACE fix).
  // `memberDecided` marks case 1 so case 2 can never override it — including
  // when the flagged signer happens to BE the first linked contact.
  let responsibleContact = contact
  let memberDecided = false

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
      if (signerContactId) {
        // A member decided the signer — the role-hint default below must never
        // override this, even when the flagged signer IS the first linked
        // contact (comparing against `contact.id` alone was the precedence
        // inversion the council caught).
        memberDecided = true
        if (signerContactId !== responsibleContact.id) {
          const { data: signerC } = await supabaseAdmin
            .from("contacts")
            .select("id, full_name, email, phone, residency, language, itin_number")
            .eq("id", signerContactId)
            .single()
          if (signerC) responsibleContact = signerC
        }
      }
    }
    // decision.kind === "no_members" → memberDecided stays false → role-hint
    // default below applies (legacy-shaped account).
  }

  if (!memberDecided) {
    // Role-hint default for the NO-members-decision case (every SMLLC, plus any
    // account whose members rows were never created). `contact` above is
    // fetchAccountAndContact's contactLinks[0] — an UNORDERED, role-blind pick,
    // the same defect that put the authorized representative on ACE Marketing
    // Group's SS-4.
    //
    // Deliberately scoped to THIS function: fetchAccountAndContact is shared
    // with generateOA and generateLease, and for an SMLLC that contact is the
    // legally named sole Member of the Operating Agreement — changing it there
    // would silently rename the member on OAs. Never move this into the shared
    // helper.
    const defaultLink = pickDefaultSs4SignerLink(
      (contactLinks ?? []).map((l) => ({
        contact_id: l.contact_id as string,
        role: (l as unknown as { role: string | null }).role ?? null,
      })),
    )
    if (defaultLink && defaultLink.contact_id !== responsibleContact.id) {
      const { data: defaultC } = await supabaseAdmin
        .from("contacts")
        .select("id, full_name, email, phone, residency, language, itin_number")
        .eq("id", defaultLink.contact_id)
        .single()
      if (defaultC) responsibleContact = defaultC
    }
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
  // A voided agreement is cancelled deliberately — marking it 'sent' makes it
  // live and actionable again in the client's portal.
  if (oa.status === "voided") {
    return { error: `This Operating Agreement is voided (cancelled). Create a new one instead of re-sending it.` }
  }
  // A partly-signed multi-owner agreement must not be knocked back to 'sent':
  // the signatures already collected stay in the counter, but every status
  // reader (portal banner, CRM) would then disagree with it and show the client
  // as if nobody had signed.
  if (oa.status === "partially_signed") {
    return { error: `This Operating Agreement is partly signed — some owners have already signed it. Re-sending would reset its status. Send each remaining owner their personal signing link instead.` }
  }

  // What this actually does: marks the agreement ready, which is what makes it
  // appear in the client's PORTAL to sign. Agreements reach clients through the
  // portal — not by email (portal notifications vastly outnumber OA link emails,
  // the last of which went out in April). This button never emailed anyone, so it
  // must not claim it did: staff were shown "Sent to <client>" while nothing had
  // happened on the client's side at all.
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
    summary: `Made OA available in the client portal for ${oa.company_name}`,
    details: { token: oa.token, contact_email: oa.member_email, source: "crm-button", emailed: false, channel: "portal" },
  })

  return {
    success: true,
    emailed: false,
    recipient: oa.member_email,
    notice: `Ready — the Operating Agreement now appears in the client's portal to sign. No email is sent.`,
    client_url: `${OA_BASE_URL}/${oa.token}/${oa.access_code}`,
  }
}

// ─── Send Lease ───

async function sendLease(token: string) {
  // Delegates the status flip to the shared operation so the CRM Send button
  // and the first-installment renewal auto-send stay on ONE code path (draft
  // guard, "viewed" protection, honest status classification). This button
  // never emailed anyone — it makes the lease appear in the client's PORTAL to
  // sign — so it must not claim it did. Mirrors the send_oa fix.
  const { sendLeaseToPortal } = await import("@/lib/operations/lease")
  const result = await sendLeaseToPortal(token)

  if (!result.success) return { error: result.error }
  if (result.already) return { already_sent: true, status: result.status }

  return {
    success: true,
    emailed: result.emailSent === true,
    recipient: result.recipient,
    notice: result.emailSent
      ? `Ready — the Lease Agreement is now in the client's portal to sign, and they've been notified (in-portal alert + email).`
      : `Ready — the Lease Agreement is now in the client's portal to sign, and they've been alerted in the portal (no confirmation email went out — check the client has an email on file).`,
    client_url: `${LEASE_BASE_URL}/${token}/${result.access_code}`,
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

      case "generate_intercompany": {
        if (!account_id) return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
        const { generateIntercompanyForAccount } = await import("@/lib/operations/intercompany")
        const result = await generateIntercompanyForAccount(account_id, {
          effective_date: params.effective_date as string | undefined,
          actor: "crm-admin",
        })
        if (result.error) return NextResponse.json({ error: result.error }, { status: 400 })
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

      case "cancel_lease_draft": {
        if (!params.token) return NextResponse.json({ error: "Missing token" }, { status: 400 })
        const { cancelLeaseDraft } = await import("@/lib/operations/lease")
        const result = await cancelLeaseDraft(params.token)
        if (!result.success) return NextResponse.json({ error: result.error }, { status: 400 })
        return NextResponse.json({ success: true, message: result.message })
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
