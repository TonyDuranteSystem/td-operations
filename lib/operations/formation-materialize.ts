/**
 * Formation materialization — turn a contact's formation submission into a
 * real CRM company when the Articles of Organization arrive.
 *
 * Antonio's architectural model (2026-05-03/04):
 * Until the state has formed the LLC, there is no account. The contact carries
 * the wizard data, the service delivery, the contact-level Drive folder, and
 * the offer-signing invoice. This helper is invoked at the moment the
 * Articles of Organization land in Drive (Upload Articles button or the
 * detection cron) and:
 *
 *   1. Reads the latest completed formation_submissions for the contact.
 *   2. Reads wizard_progress.data.chosen_name_final for the picked LLC name.
 *   3. Idempotency: returns already_materialized if a real (non-Pending
 *      Formation, non-Cancelled) account is already linked to the contact.
 *   4. Creates the account (status='Active', account_type='Client',
 *      entity_type from submission, state_of_formation from submission state,
 *      formation_date / filing_id / registered_agent_id from caller params).
 *   5. Links the owner via account_contacts (Owner role).
 *   6. For MMLLC: materializes additional members — find-or-create contacts,
 *      account_contacts links (Member role), members rows, copies each
 *      member's passport from Supabase storage to Drive, document records.
 *   7. Writes the owner's members row (so SS-4 line 9a / responsible-party
 *      lookup works for MMLLC; harmless for SMLLC).
 *   8. Creates the company Drive folder and migrates the contact folder.
 *   9. Updates the active "Company Formation" SD: sets account_id + service_name.
 *  10. Syncs portal tier to 'formation' on the new account (cascades to
 *      contacts).
 *
 * What this helper does NOT do (deferred):
 *   - Fire ss4_create. SS-4 needs registered_agent_id with a county-set RA
 *     address; the helper records `ss4_pending` in the steps so admin can
 *     create the SS-4 next via the existing tool. Auto-fire is a future
 *     refinement that requires extracting the SS-4 logic out of the MCP layer.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { formationStateForClient } from "@/lib/formation/state-lookup"
import { reanchorLeadConversations } from "@/lib/team/reanchor-conversations"
import { logAction } from "@/lib/mcp/action-log"
import { ensureCompanyFolder, migrateContactToCompany } from "@/lib/drive-folder-utils"
import { extractMembersFromWizardData } from "@/lib/utils/wizard-members"
import { resolveMemberContactId } from "@/lib/members/resolve-member-contact"
import { normalizePersonName, normalizeEmail } from "@/lib/members/member-identity"
import { syncTier } from "./sync-tier"
import { uploadBinaryToDrive } from "@/lib/google-drive"

const STATE_NAME_FROM_CODE: Record<string, string> = {
  NM: "New Mexico",
  WY: "Wyoming",
  FL: "Florida",
  DE: "Delaware",
}

export interface MaterializeFormationParams {
  contact_id: string
  /** ISO YYYY-MM-DD. Defaults to today if omitted. */
  formation_date?: string
  /** Secretary of State filing identifier, optional. */
  filing_id?: string
  /** FK to addresses.id. Optional — admin can link RA after materialization. */
  registered_agent_id?: string
  /**
   * Admin-supplied state of formation. When provided, overrides any state
   * value on formation_submissions. Required when no formation_submissions
   * row exists for the contact (resolver falls back to wizard_progress, which
   * does not capture the formation state — only owner residence).
   */
  formation_state?: "NM" | "WY" | "FL" | "DE"
  /**
   * Admin-supplied entity type override. Highest-priority source — wins over
   * the signed contract and form/wizard data. Use when the automatic
   * resolution (contract → form → wizard) cannot determine the type.
   */
  entity_type?: "SMLLC" | "MMLLC"
  /**
   * Explicit chosen company name. Highest-priority name source — overrides the
   * `wizard_progress.data.chosen_name_final` lookup. Used by the flow-advance
   * auto-materialize (advance to "Articles Received"), where the confirmed name
   * lives in `service_deliveries.name_checks` (status 'filed'), not in
   * chosen_name_final. Existing callers omit this and keep the wizard lookup.
   */
  chosen_name?: string
  actor?: string
}

export type MaterializeStep = {
  step: string
  status: "ok" | "skipped" | "error"
  detail?: string
}

export interface MaterializeFormationResult {
  success: boolean
  outcome:
    | "materialized"
    | "already_materialized"
    | "missing_chosen_name"
    | "missing_submission"
    | "invalid_state"
    | "missing_entity_type"
    | "error"
  account_id?: string
  steps: MaterializeStep[]
  error?: string
}

const VALID_STATE_CODES = new Set(["NM", "WY", "FL", "DE"])

// ─── Shared formation-source resolver (materializer + preflight) ─────────────

/** The two rows the source decision is made from. */
export interface FormationSourceRows {
  sub: {
    id: string
    submitted_data: unknown
    upload_paths: unknown
    state: string | null
    entity_type: string | null
    created_at: string | null
  } | null
  wp: { id: string; data: unknown; lead_id: string | null; created_at: string | null } | null
}

export interface FormationSourceData {
  submissionId: string | null
  resolverSource: "formation_submissions" | "wizard_progress"
  submittedData: Record<string, unknown>
  uploadPaths: string[]
  submissionState: string | null
  submissionEntityType: string | null
  wizardData: Record<string, unknown>
  wp: FormationSourceRows["wp"]
  /** Human note when a submission row was deliberately bypassed (recency pin). */
  note: string | null
}

/**
 * PURE decision: which data source feeds materialization.
 *
 * Recency pin (council 2026-07-28): when the newest submission predates the
 * CURRENT wizard run, it belongs to an EARLIER formation — using it would
 * bleed the old company's entity type / members / passports into the new one
 * (returning-client hazard). In that case the wizard fallback wins.
 */
export function selectFormationSource(rows: FormationSourceRows): FormationSourceData {
  const { sub, wp } = rows
  const wizardData = (wp?.data || {}) as Record<string, unknown>

  const subIsStale = !!(
    sub && wp?.created_at && sub.created_at && sub.created_at < wp.created_at
  )

  if (sub && !subIsStale) {
    return {
      submissionId: sub.id,
      resolverSource: "formation_submissions",
      submittedData: (sub.submitted_data || {}) as Record<string, unknown>,
      uploadPaths: Array.isArray(sub.upload_paths) ? (sub.upload_paths as string[]) : [],
      submissionState: sub.state ?? null,
      submissionEntityType: sub.entity_type ?? null,
      wizardData,
      wp,
      note: null,
    }
  }

  // Wizard fallback — extract upload paths using the same convention
  // wizard-submit uses (any string value starting with "formation/").
  const uploadPaths: string[] = []
  for (const val of Object.values(wizardData)) {
    if (typeof val === "string" && val.startsWith("formation/")) uploadPaths.push(val)
  }
  return {
    submissionId: null,
    resolverSource: "wizard_progress",
    submittedData: wizardData,
    uploadPaths,
    submissionState: null,
    submissionEntityType: (wizardData.entity_type as string | undefined) ?? null,
    wizardData,
    wp,
    note: sub && subIsStale
      ? `Newest submission ${sub.id} (${sub.created_at}) predates the current wizard run (${wp?.created_at}) — treated as a previous formation's data; using the wizard data instead.`
      : null,
  }
}

/**
 * Fetch + select the formation data source for a contact.
 *
 * The submission read accepts status 'completed' OR 'reviewed', newest first:
 * the formation-setup job auto-flips every submission to 'reviewed' seconds
 * after submit, so a completed-only read matched NOTHING for any normally
 * processed client and silently starved the entity-type resolver (the
 * Covelli/DoctorGut incident, 2026-07-28). One query, newest first — never
 * 'completed' before a newer 'reviewed' row (a stale completed row from an
 * older formation must not win).
 */
export async function fetchFormationSourceData(contactId: string): Promise<FormationSourceData> {
  const { data: sub } = await supabaseAdmin
    .from("formation_submissions")
    .select("id, submitted_data, upload_paths, state, entity_type, created_at")
    .eq("contact_id", contactId)
    .in("status", ["completed", "reviewed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: wp } = await supabaseAdmin
    .from("wizard_progress")
    .select("id, data, lead_id, created_at")
    .eq("contact_id", contactId)
    .eq("wizard_type", "formation")
    .eq("status", "submitted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return selectFormationSource({ sub: sub ?? null, wp: wp ?? null })
}

// ─── Deterministic preflight (dry-run of the materialization gates) ──────────

export type FormationPreflightFailure =
  | "missing_submission"
  | "missing_chosen_name"
  | "missing_entity_type"

export interface FormationMaterializePreflightResult {
  ok: boolean
  failure?: FormationPreflightFailure
  error?: string
  chosen_name?: string | null
  entity_code?: "SMLLC" | "MMLLC"
  entity_source?: string
  entity_detail?: string
}

/**
 * Read-only dry-run of the DETERMINISTIC gates materializeFormationCompany
 * applies: formation data present, a chosen company name, and a resolvable
 * entity type. Used (a) by advanceServiceDelivery to REFUSE the advance into
 * "Articles Received" BEFORE the stage move commits — a deterministic
 * materialization failure must never be a silent success (Covelli/DoctorGut,
 * council 2026-07-28) — and (b) by the workspace Articles-upload modal to
 * decide whether to require the staff LLC-type field. Mutates nothing. Must
 * stay in lockstep with the materializer's own resolution (same source
 * selection via fetchFormationSourceData, same resolver inputs).
 */
export async function preflightFormationMaterialization(input: {
  contact_id: string
  /** The confirmed/filed company name when the caller has one (name_checks). */
  chosen_name?: string | null
  /** Staff-supplied LLC-type override (wins over every other source). */
  entity_type?: "SMLLC" | "MMLLC" | null
}): Promise<FormationMaterializePreflightResult> {
  const src = await fetchFormationSourceData(input.contact_id)

  if (src.resolverSource === "wizard_progress" && !src.wp) {
    return {
      ok: false,
      failure: "missing_submission",
      error:
        "No completed formation submission and no submitted formation wizard found for this contact. Ask the client to (re)submit the formation wizard from the portal.",
    }
  }

  const chosenName = String(
    input.chosen_name || src.wizardData.chosen_name_final || src.wizardData.chosen_name || "",
  ).trim()
  if (!chosenName) {
    return {
      ok: false,
      failure: "missing_chosen_name",
      error:
        "No confirmed company name yet. Mark the filed LLC name first (Name checks → the name the state approved).",
    }
  }

  const { resolveEntityTypeForFormation } = await import("@/lib/portal/entity-type-from-contract")
  const resolution = await resolveEntityTypeForFormation({
    contactId: input.contact_id,
    leadId: src.wp?.lead_id ?? null,
    adminOverride: input.entity_type ?? null,
    submissionEntityType: src.submissionEntityType,
    wizardEntityType: (src.wizardData.entity_type as string | undefined) ?? null,
  })
  if (resolution.source === "corporation_manual" || !resolution.wizardCode || !resolution.accountLabel) {
    return {
      ok: false,
      failure: "missing_entity_type",
      error: resolution.detail,
      chosen_name: chosenName,
    }
  }

  return {
    ok: true,
    chosen_name: chosenName,
    entity_code: resolution.wizardCode,
    entity_source: resolution.source,
    entity_detail: resolution.detail,
  }
}

export async function materializeFormationCompany(
  params: MaterializeFormationParams,
): Promise<MaterializeFormationResult> {
  const steps: MaterializeStep[] = []
  const actor = params.actor || "system:formation-materialize"
  const today = new Date().toISOString().slice(0, 10)
  const formationDate = params.formation_date || today

  if (!params.contact_id) {
    return { success: false, outcome: "error", steps, error: "contact_id is required" }
  }

  // Member passports queued during the MMLLC loop and uploaded after the
  // company folder exists (we need the company's "2. Contacts" subfolder ID).
  const pendingMemberPassports: {
    contact_id: string
    contact_name: string
    storage_path: string
    index: number
  }[] = []

  // Flexible formation-data resolver — shared with the deterministic preflight
  // (fetchFormationSourceData / selectFormationSource above): newest submission
  // in status completed OR reviewed, wizard fallback when it is missing or
  // belongs to an earlier formation (recency pin). Admin-supplied state
  // (params.formation_state) overrides any state on the submission row, since
  // wizard_progress never captures the formation state and admin is the only
  // source of truth at upload time.
  try {
    const src = await fetchFormationSourceData(params.contact_id)
    const { resolverSource, submittedData, uploadPaths, submissionState, submissionEntityType, submissionId } = src
    const wp = src.wp
    const wizardData = src.wizardData

    if (resolverSource === "formation_submissions") {
      steps.push({ step: "fetch_submission", status: "ok", detail: `formation_submissions ${submissionId}` })
    } else {
      // Wizard fallback. Surgical recovery path for the pre-fix wizard-submit
      // window where formation_submissions could be missing while
      // wizard_progress was correctly written — and for the recency pin.
      if (!wp) {
        return {
          success: false,
          outcome: "missing_submission",
          steps,
          error:
            "No completed formation submission found for this contact, and no submitted formation wizard either. Ask the client to (re)submit the formation wizard from the portal.",
        }
      }
      steps.push({
        step: "fetch_submission",
        status: "skipped",
        detail:
          src.note ??
          `No formation_submissions row — falling back to wizard_progress ${wp.id} (self-heal will write the missing row on success)`,
      })
    }

    const chosenName = String(params.chosen_name || wizardData.chosen_name_final || wizardData.chosen_name || "").trim()
    if (!chosenName) {
      return {
        success: false,
        outcome: "missing_chosen_name",
        steps,
        error: "No chosen LLC name on wizard data. Use 'Confirm Selected Name' on the contact page first.",
      }
    }
    steps.push({ step: "fetch_chosen_name", status: "ok", detail: chosenName })

    // 3. Idempotency — skip only if THIS formation's company already exists for
    // the contact, matched by the chosen company name. An existing client
    // opening a NEW, differently-named company must NOT be blocked. The old
    // guard skipped whenever the contact had ANY non-cancelled account, which
    // made a second company impossible to materialize (e.g. Adam Mihaly already
    // owns THW Global LLC, so his new LUMA company could never be created).
    // Matching on the chosen name still prevents double-materializing the same
    // formation (a re-run finds the just-created company and no-ops) and leaves
    // legacy placeholders / other companies alone.
    const { data: existingLinks } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id, accounts:account_id(id, company_name, status)")
      .eq("contact_id", params.contact_id)

    if (existingLinks && existingLinks.length > 0) {
      const chosenLower = chosenName.toLowerCase().trim()
      const sameCompany = existingLinks.find(l => {
        const acc = l.accounts as unknown as { id: string; company_name: string; status: string } | null
        return acc && acc.status !== "Cancelled" && acc.status !== "Closed" &&
          (acc.company_name || "").toLowerCase().trim() === chosenLower
      })
      if (sameCompany) {
        const acc = sameCompany.accounts as unknown as { id: string; company_name: string; status: string }
        steps.push({
          step: "idempotency_check",
          status: "skipped",
          detail: `"${acc.company_name}" (${acc.status}) already materialized for this contact — this formation is already a company.`,
        })
        return { success: true, outcome: "already_materialized", account_id: acc.id, steps }
      }
      steps.push({
        step: "idempotency_check",
        status: "ok",
        detail: `Contact has ${existingLinks.length} existing account link(s), none named "${chosenName}" — proceeding to create the new company.`,
      })
    }

    // 4. State + entity_type.
    // Admin-supplied state wins. When no admin value was provided the internal
    // chain is: submission row's state → the contact's SIGNED offer's pinned
    // state (WS-B scope amendment — before it, callers with no param, e.g. the
    // articles-detector cron, could only see the submission) → error. NM never
    // silently self-applies here: materialization records a LEGAL filing fact,
    // so with nothing decided anywhere a human must supply the state.
    let resolvedStateRaw = params.formation_state
      ? params.formation_state
      : String(submissionState || "").toUpperCase().trim()
    if (!VALID_STATE_CODES.has(resolvedStateRaw) && !params.formation_state) {
      const offerState = await formationStateForClient({ contactId: params.contact_id })
      if (offerState) {
        resolvedStateRaw = offerState
        steps.push({
          step: "state_from_offer",
          status: "ok",
          detail: `No admin/submission state — using the signed offer's pinned state ${offerState}.`,
        })
      }
    }
    if (!VALID_STATE_CODES.has(resolvedStateRaw)) {
      return {
        success: false,
        outcome: "invalid_state",
        steps,
        error: params.formation_state
          ? `Invalid formation_state "${params.formation_state}". Expected one of NM/WY/FL/DE.`
          : `No formation state available (submission: "${submissionState ?? "—"}", no signed offer carries one, resolver source: ${resolverSource}). Admin must pass formation_state at upload time (NM/WY/FL/DE).`,
      }
    }
    const stateName = STATE_NAME_FROM_CODE[resolvedStateRaw]
    if (params.formation_state && submissionState && submissionState.toUpperCase() !== params.formation_state) {
      steps.push({
        step: "state_override",
        status: "ok",
        detail: `Admin-supplied state ${params.formation_state} overrides submission state ${submissionState}`,
      })
    }

    const submitted = submittedData

    // 4b. Entity type — resolved from what the client BOUGHT, never defaulted.
    // Priority: admin override > signed contract (contracts.llc_type via this
    // formation's lead) > formation form > wizard data. If nothing resolves,
    // fail loudly with missing_entity_type — the 2026-06-11 LUMA incident was
    // caused by a silent SMLLC default here while the signed contract said
    // MMLLC. Resolution logic: lib/portal/entity-type-from-contract.ts.
    const { resolveEntityTypeForFormation } = await import("@/lib/portal/entity-type-from-contract")
    const resolution = await resolveEntityTypeForFormation({
      contactId: params.contact_id,
      leadId: wp?.lead_id ?? null,
      adminOverride: params.entity_type ?? null,
      submissionEntityType,
      wizardEntityType: (wizardData.entity_type as string | undefined) ?? null,
    })

    if (resolution.source === "corporation_manual") {
      return { success: false, outcome: "missing_entity_type", steps, error: resolution.detail }
    }
    if (!resolution.wizardCode || !resolution.accountLabel) {
      return { success: false, outcome: "missing_entity_type", steps, error: resolution.detail }
    }
    steps.push({ step: "entity_type_resolution", status: "ok", detail: `${resolution.accountLabel} via ${resolution.source} — ${resolution.detail}` })
    if (resolution.conflictWarning) {
      steps.push({ step: "entity_type_conflict", status: "error", detail: resolution.conflictWarning })
    }

    const resolvedEntityCode = resolution.wizardCode
    const entityType: "Single Member LLC" | "Multi Member LLC" = resolution.accountLabel
    const isMMLC = entityType === "Multi Member LLC"

    // 5. Create the account. member_structure is kept in lockstep with
    // entity_type so the two columns can never diverge (the manual LUMA fix
    // touched only entity_type and left member_structure NULL).
    const accountInsert: Record<string, unknown> = {
      company_name: chosenName,
      entity_type: entityType,
      member_structure: isMMLC ? "multi_member" : "single_member",
      state_of_formation: stateName,
      formation_date: formationDate,
      filing_id: params.filing_id || null,
      status: "Active",
      account_type: "Client",
    }
    if (params.registered_agent_id) accountInsert.registered_agent_id = params.registered_agent_id

    // eslint-disable-next-line no-restricted-syntax -- materialization writes to accounts directly; central path
    const { data: newAccount, error: accErr } = await supabaseAdmin
      .from("accounts")
      .insert(accountInsert as never)
      .select("id")
      .single()

    if (accErr || !newAccount) {
      return {
        success: false,
        outcome: "error",
        steps,
        error: `Failed to create account: ${accErr?.message || "no data returned"}`,
      }
    }
    const accountId = newAccount.id
    steps.push({ step: "account_create", status: "ok", detail: `Account ${accountId} created (${chosenName}, ${entityType}, ${stateName})` })

    // Initial renewal dates (plan c2d97552 B2a). This intake path historically
    // set none — companies materialized from Articles were invisible to the
    // compliance calendar and the RA/AR reminder crons (the LUMA-cohort bug).
    // Company-creation moment, so fill-if-null is safe by construction.
    try {
      const { deriveRenewalDates, applyRenewalDateFills } = await import("@/lib/operations/renewal-dates")
      const fills = deriveRenewalDates({
        intake: "formation",
        formation_date: formationDate,
        state_of_formation: stateName,
        existing: { ra_renewal_date: null, annual_report_due_date: null, cmra_renewal_date: null },
      })
      const applied = await applyRenewalDateFills(accountId, fills, { state: stateName, actor: "materialize-formation" })
      if (applied.length) steps.push({ step: "renewal_dates", status: "ok", detail: applied.join(", ") })
    } catch (rdErr) {
      steps.push({ step: "renewal_dates", status: "error", detail: rdErr instanceof Error ? rdErr.message : String(rdErr) })
    }

    // Record the lead→account conversion (this path previously logged neither
    // converted_to_account_id nor a re-anchor) and move any Team Chat
    // conversations opened on the lead onto the new account (dev_task be582c5e Phase 2).
    if (wp?.lead_id) {
      await supabaseAdmin
        .from("leads")
        .update({ converted_to_account_id: accountId, converted_at: new Date().toISOString() })
        .eq("id", wp.lead_id)
      await reanchorLeadConversations(wp.lead_id, accountId)
      steps.push({ step: "lead_converted", status: "ok", detail: `Lead ${wp.lead_id} → account ${accountId}` })
    }

    // 6. Link owner contact.
    await supabaseAdmin
      .from("account_contacts")
      .upsert(
        {
          account_id: accountId,
          contact_id: params.contact_id,
          role: "Owner",
        },
        { onConflict: "account_id,contact_id" },
      )
    steps.push({ step: "owner_link", status: "ok", detail: "Owner linked to account" })

    // 7. MMLLC additional members.
    let primaryMemberIndex = 0
    let additionalPctSum = 0
    if (isMMLC) {
      const additionalMembers = extractMembersFromWizardData(submitted)
      // Uses the resolver-supplied uploadPaths (from formation_submissions when
      // present; extracted from wizard_progress.data when in fallback mode).
      primaryMemberIndex = typeof submitted.primary_member_index === "number" ? submitted.primary_member_index as number : 0

      // Flag genuine same-(name+email) duplicates across the owner and the
      // individual members. Members may share one email (family LLC) if their
      // names differ; identical name AND email is indistinguishable and would
      // corrupt the members/ownership tables, so we SKIP and flag it (never
      // silently drop via a unique-violation) and exclude it from the sums.
      const ownerDupName = [submitted.owner_first_name, submitted.owner_last_name].filter(Boolean).map(String).join(" ") || null
      const ownerDupEmail = submitted.owner_email ? String(submitted.owner_email) : null
      const skippedMemberIdx = new Set<number>()
      {
        const seen = new Set<string>()
        if (ownerDupName && ownerDupEmail) seen.add(`${normalizePersonName(ownerDupName)} ${normalizeEmail(ownerDupEmail)}`)
        for (let i = 0; i < additionalMembers.length; i++) {
          const mm = additionalMembers[i]
          if (mm.member_type !== "individual") continue
          const nm = [mm.member_first_name, mm.member_last_name].filter(Boolean).join(" ")
          const em = mm.member_email
          if (!nm || !em) continue
          const key = `${normalizePersonName(nm)} ${normalizeEmail(em)}`
          if (seen.has(key)) {
            skippedMemberIdx.add(i)
            steps.push({ step: `member_${i + 1}`, status: "error", detail: `Duplicate member "${nm}" (${em}) — same name and email as the owner or another member. Skipped to protect the ownership table; please correct and re-materialize.` })
          } else {
            seen.add(key)
          }
        }
      }
      additionalPctSum = additionalMembers.reduce((sum, m, idx) => skippedMemberIdx.has(idx) ? sum : sum + (m.member_ownership_pct ?? 0), 0)

      // Update owner is_primary on account_contacts based on picker.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- is_primary not in generated types yet
      await supabaseAdmin.from("account_contacts")
        .update({ is_primary: primaryMemberIndex === 0 } as any)
        .eq("account_id", accountId)
        .eq("contact_id", params.contact_id)

      const now = new Date().toISOString()
      for (let i = 0; i < additionalMembers.length; i++) {
        if (skippedMemberIdx.has(i)) continue
        const m = additionalMembers[i]
        const isPrimary = primaryMemberIndex === i + 1
        const ownershipPct = m.member_ownership_pct
        try {
          if (m.member_type === "company") {
            const repEmail = m.member_rep_email ? String(m.member_rep_email).toLowerCase().trim() : null
            const repName = m.member_rep_name ? String(m.member_rep_name).trim() : null
            const memberCompanyName = m.member_company_name ? String(m.member_company_name).trim() : `Company Member ${i + 1}`

            await supabaseAdmin.from("members").insert(
              {
                account_id: accountId,
                member_type: "company",
                company_name: memberCompanyName,
                ein: m.member_company_ein ?? null,
                address_street: m.member_company_street ?? null,
                address_city: m.member_company_city ?? null,
                address_state: m.member_company_state ?? null,
                address_zip: m.member_company_zip ?? null,
                address_country: m.member_company_country ?? null,
                ownership_pct: ownershipPct,
                is_primary: false,
                // Signer selected in the MMLLC formation wizard. A company member
                // can be the SS-4 Responsible Party — it resolves to its
                // representative at SS-4 generation (decideSs4Signer).
                is_signer: m.is_signer === true,
                representative_name: repName,
                representative_email: repEmail,
                representative_address_street: m.member_rep_address_street ?? null,
                representative_address_city: m.member_rep_address_city ?? null,
                representative_address_state: m.member_rep_address_state ?? null,
                representative_address_zip: m.member_rep_address_zip ?? null,
                representative_address_country: m.member_rep_address_country ?? null,
                updated_at: now,
              },
            )

            // Find-or-create the representative contact for portal access.
            if (repEmail) {
              // Resolve the representative's contact by email + name (shared resolver).
              const repContactId = await resolveMemberContactId({ email: repEmail, name: repName, now })
              if (repContactId) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- is_primary not in types
                await supabaseAdmin.from("account_contacts").upsert(
                  {
                    account_id: accountId,
                    contact_id: repContactId,
                    role: "Member",
                    is_primary: false,
                    ...(ownershipPct !== null && { ownership_pct: ownershipPct }),
                  } as any,
                  { onConflict: "account_id,contact_id" },
                )
                steps.push({ step: `member_${i + 1}_link`, status: "ok", detail: `${memberCompanyName} (rep: ${repName ?? repEmail})` })
              } else {
                steps.push({ step: `member_${i + 1}_link`, status: "skipped", detail: `${memberCompanyName} — could not create representative contact` })
              }
            } else {
              steps.push({ step: `member_${i + 1}_link`, status: "ok", detail: `${memberCompanyName} (no representative email)` })
            }
          } else {
            // Individual member.
            const memberEmail = m.member_email ? String(m.member_email).toLowerCase().trim() : null
            const memberName = [m.member_first_name, m.member_last_name].filter(Boolean).join(" ") || memberEmail || `Member ${i + 1}`

            // Resolve this member's own contact by email + name (shared resolver),
            // refreshing the fields the wizard provided. Distinct people who share
            // one email each keep their own contact.
            const membContactId = await resolveMemberContactId({
              email: memberEmail,
              name: memberName,
              first_name: m.member_first_name,
              last_name: m.member_last_name,
              refresh: {
                date_of_birth: m.member_dob,
                citizenship: m.member_nationality,
                address_line1: m.member_street,
                address_city: m.member_city,
                address_state: m.member_state_province,
                address_zip: m.member_zip,
                address_country: m.member_country,
              },
              now,
            })

            // ── The ownership row is written UNCONDITIONALLY ──────────────
            // Membership is a legal fact; portal access is not (Antonio,
            // 2026-08-09). A member with no email is still a member: on the
            // filing, in the Operating Agreement, and counted in the ownership
            // table. They simply get no contact and no login.
            //
            // This whole block used to sit inside `if (membContactId)`, and
            // resolveMemberContactId returns null without an email — so an
            // email-less member produced NO ownership row at all while their
            // percentage was still subtracted from the owner's share (that
            // subtraction, at additionalPctSum above, is correct and stays).
            // The result was a members table summing to LESS than 100 and a
            // person missing from the SS-4 and the OA. `members.contact_id` is
            // nullable precisely for this case. (dev job fc69557f.)
            const { error: memberRowErr } = await supabaseAdmin.from("members").insert(
              {
                account_id: accountId,
                member_type: "individual",
                full_name: memberName,
                email: memberEmail,
                address_street: m.member_street ?? null,
                address_city: m.member_city ?? null,
                address_state: m.member_state_province ?? null,
                address_zip: m.member_zip ?? null,
                address_country: m.member_country ?? null,
                ownership_pct: ownershipPct,
                is_primary: isPrimary,
                // Signer selected in the MMLLC formation wizard
                // (member_{idx}_is_signer). See is_signer note above.
                is_signer: m.is_signer === true,
                contact_id: membContactId,
                updated_at: now,
              },
            )
            // supabase-js RETURNS errors rather than throwing, so the enclosing
            // try/catch cannot see this one. Unchecked, the step below would
            // assert "ownership recorded" about a row that was never written —
            // a false green on a legal fact, which is the whole thing this
            // change exists to make trustworthy.
            if (memberRowErr) {
              steps.push({
                step: `member_${i + 1}_link`,
                status: "error",
                detail: `${memberName} — OWNERSHIP ROW FAILED TO WRITE (${memberRowErr.message}). The ownership table will not total 100 until this is fixed.`,
              })
            }

            if (membContactId) {
              // Portal-facing work — only possible for a member we can identify.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- is_primary not in types
              await supabaseAdmin.from("account_contacts").upsert(
                {
                  account_id: accountId,
                  contact_id: membContactId,
                  role: "Member",
                  is_primary: isPrimary,
                  ...(ownershipPct !== null && { ownership_pct: ownershipPct }),
                } as any,
                { onConflict: "account_id,contact_id" },
              )

              steps.push({ step: `member_${i + 1}_link`, status: "ok", detail: `${memberName}${isPrimary ? " [PRIMARY]" : ""}` })

              // Copy member passport from Supabase storage to Drive (we'll add to
              // the company folder after we create it; for now, just queue the
              // path for the post-folder upload). Match both the portal wizard
              // key (member_{i}_member_passport) and the legacy standalone-form
              // key (passport_member_{i}).
              const passportPath = uploadPaths.find(p => p.includes(`member_${i}_member_passport`) || p.includes(`passport_member_${i}`))
              if (passportPath) {
                pendingMemberPassports.push({
                  contact_id: membContactId,
                  contact_name: memberName,
                  storage_path: passportPath,
                  index: i + 1,
                })
              }
            } else if (!memberRowErr) {
              // resolveMemberContactId returns null for TWO different reasons —
              // no email supplied, or the contact insert failed. Reporting both
              // as "no email" tells staff something false about a member who
              // did supply one, so they are separated here.
              if (!memberEmail) {
                steps.push({
                  step: `member_${i + 1}_link`,
                  status: "ok",
                  detail: `${memberName}${isPrimary ? " [PRIMARY]" : ""} — ownership recorded (${ownershipPct ?? "?"}%); NO EMAIL, so no contact and no portal access for this member`,
                })
              } else {
                steps.push({
                  step: `member_${i + 1}_link`,
                  status: "error",
                  detail: `${memberName} — ownership recorded (${ownershipPct ?? "?"}%) but the CONTACT COULD NOT BE CREATED for ${memberEmail}. Needs a manual contact + link.`,
                })
              }
            }
          }
        } catch (membErr) {
          steps.push({ step: `member_${i + 1}`, status: "error", detail: membErr instanceof Error ? membErr.message : String(membErr) })
        }
      }
    }

    // 8. Owner members row (for MMLLC SS-4 lookup; harmless duplicate-safe for SMLLC).
    if (isMMLC) {
      const ownerFirst = submitted.owner_first_name ? String(submitted.owner_first_name).trim() : ""
      const ownerLast = submitted.owner_last_name ? String(submitted.owner_last_name).trim() : ""
      const ownerFullName = [ownerFirst, ownerLast].filter(Boolean).join(" ") || null
      const ownerEmail = submitted.owner_email ? String(submitted.owner_email).toLowerCase().trim() : null
      const ownerPct = Math.max(0, Math.round((100 - additionalPctSum) * 100) / 100)
      await supabaseAdmin.from("members").insert(
        {
          account_id: accountId,
          member_type: "individual",
          full_name: ownerFullName,
          email: ownerEmail,
          address_street: submitted.owner_street ? String(submitted.owner_street) : null,
          address_city: submitted.owner_city ? String(submitted.owner_city) : null,
          address_state: submitted.owner_state_province ? String(submitted.owner_state_province) : null,
          address_zip: submitted.owner_zip ? String(submitted.owner_zip) : null,
          address_country: submitted.owner_country ? String(submitted.owner_country) : null,
          ownership_pct: ownerPct,
          is_primary: primaryMemberIndex === 0,
          // Owner is the SS-4 Responsible Party when they selected themselves on
          // the owner step of the MMLLC formation wizard (owner_is_signer).
          is_signer: submitted.owner_is_signer === true,
          contact_id: params.contact_id,
          updated_at: new Date().toISOString(),
        },
      )
      steps.push({ step: "owner_member_row", status: "ok", detail: `Owner member row (${ownerPct}%)` })
    }

    // 9. Drive folder + migration.
    const { data: ownerContact } = await supabaseAdmin
      .from("contacts")
      .select("first_name, last_name, gdrive_folder_url, drive_folder_id")
      .eq("id", params.contact_id)
      .single()
    const ownerName = ownerContact ? [ownerContact.first_name, ownerContact.last_name].filter(Boolean).join(" ") : ""

    let companyContactsSubfolderId: string | null = null
    // "1. Company" subfolder — where the Articles of Organization + EIN letter
    // belong. Captured so step 10a-bis can relocate flow-uploaded Articles that
    // are still parked in Supabase Storage into Drive.
    let companyDocsSubfolderId: string | null = null
    try {
      const folderResult = await ensureCompanyFolder(accountId, chosenName, stateName, ownerName)
      companyContactsSubfolderId = folderResult.subfolders["2. Contacts"] ?? null
      companyDocsSubfolderId = folderResult.subfolders["1. Company"] ?? null
      steps.push({
        step: "drive_folder",
        status: "ok",
        detail: folderResult.created ? "Company Drive folder created" : "Company Drive folder already exists, linked",
      })

      // Multi-company guard: if the owner already belongs to another active
      // company, their contact Drive folder may live INSIDE that company —
      // migrating it would drag the other company's files along and re-point
      // the contact away from it. So for multi-company owners we do NOT migrate;
      // instead we copy the owner passport from storage straight into THIS
      // company's "2. Contacts" (same path as additional members) and relink the
      // staging passport document to this account. Single-company owners keep
      // the original migrate behavior (their contact folder is their own).
      const ownerHasOtherActiveAccount = (existingLinks ?? []).some(l => {
        const acc = l.accounts as unknown as { status: string } | null
        return acc && acc.status !== "Cancelled" && acc.status !== "Closed"
      })

      if (ownerHasOtherActiveAccount) {
        const ownerPassportPath = typeof submitted.passport_owner === "string"
          ? submitted.passport_owner
          : uploadPaths.find(p => p.includes("passport_owner")) || null
        if (ownerPassportPath && companyContactsSubfolderId) {
          try {
            const cleanPath = ownerPassportPath.replace(/^\/+/, "")
            // Duplicate-upload guard (LT Program incident class): a re-run
            // must not re-copy — the prior run already relinked/inserted the
            // documents row, so skip the whole block.
            const { fileExistsInFolder } = await import("@/lib/google-drive")
            const ownerDup = await fileExistsInFolder(companyContactsSubfolderId, cleanPath.split("/").pop() || "passport.pdf")
            if (ownerDup.exists) {
              steps.push({ step: "owner_passport_copy", status: "skipped", detail: `Already on Drive (${ownerDup.id})` })
            } else {
            const { data: blob, error: dlErr } = await supabaseAdmin.storage
              .from("onboarding-uploads")
              .download(cleanPath)
            if (dlErr || !blob) {
              steps.push({ step: "owner_passport_copy", status: "error", detail: dlErr?.message || "Download failed" })
            } else {
              const fileName = cleanPath.split("/").pop() || "passport.pdf"
              const buffer = Buffer.from(await blob.arrayBuffer())
              const mimeType = blob.type || "application/octet-stream"
              const driveFile = await uploadBinaryToDrive(fileName, buffer, mimeType, companyContactsSubfolderId) as { id: string }
              const newLink = `https://drive.google.com/file/d/${driveFile.id}/view`
              // Relink the staging owner-passport doc row (created by
              // formation_setup with account_id=null) to this company + the new
              // Drive file, so there is exactly one row in the right place.
              const { data: relinked } = await supabaseAdmin
                .from("documents")
                .update({ account_id: accountId, drive_file_id: driveFile.id, drive_link: newLink, updated_at: new Date().toISOString() })
                .eq("contact_id", params.contact_id)
                .eq("document_type_name", "Passport")
                .eq("category", 2)
                .is("account_id", null)
                .select("id")
              if (!relinked || relinked.length === 0) {
                await supabaseAdmin.from("documents").insert({
                  file_name: fileName,
                  drive_file_id: driveFile.id,
                  drive_link: newLink,
                  document_type_name: "Passport",
                  category: 2,
                  category_name: "Contacts",
                  status: "classified",
                  contact_id: params.contact_id,
                  account_id: accountId,
                  portal_visible: true,
                })
              }
              steps.push({ step: "owner_passport_copy", status: "ok", detail: `Owner passport placed in company 2.Contacts (${driveFile.id})` })
            }
            }
          } catch (e) {
            steps.push({ step: "owner_passport_copy", status: "error", detail: e instanceof Error ? e.message : String(e) })
          }
        }
        steps.push({ step: "drive_migration", status: "skipped", detail: "Multi-company owner — contact folder NOT migrated (other company left intact)" })
      } else {
        const contactFolderId = ownerContact?.drive_folder_id || (() => {
          const u = ownerContact?.gdrive_folder_url
          if (!u) return null
          const m = u.match(/folders\/([a-zA-Z0-9_-]+)/)
          return m?.[1] ?? null
        })()
        if (contactFolderId && contactFolderId !== folderResult.folderId) {
          const migrationResult = await migrateContactToCompany(contactFolderId, folderResult.folderId, params.contact_id)
          steps.push({
            step: "drive_migration",
            status: migrationResult.errors.length > 0 ? "error" : "ok",
            detail: `${migrationResult.moved} file(s) migrated${migrationResult.errors.length > 0 ? `, ${migrationResult.errors.length} error(s)` : ""}`,
          })
        }
      }
    } catch (driveErr) {
      steps.push({ step: "drive_folder", status: "error", detail: driveErr instanceof Error ? driveErr.message : String(driveErr) })
    }

    // 9b. Member passports (after company folder exists).
    if (companyContactsSubfolderId && pendingMemberPassports.length > 0) {
      // Duplicate-upload guard (LT Program incident class): skip files already
      // on Drive — the prior run also inserted their documents rows.
      const { folderFileNameMap } = await import("@/lib/google-drive")
      const contactsNames = await folderFileNameMap(companyContactsSubfolderId)
      for (const mp of pendingMemberPassports) {
        try {
          const cleanPath = mp.storage_path.replace(/^\/+/, "")
          const dupName = cleanPath.split("/").pop() || `passport_member_${mp.index}.pdf`
          if (contactsNames?.has(dupName)) {
            steps.push({ step: `member_${mp.index}_passport`, status: "skipped", detail: `Already on Drive (${contactsNames.get(dupName)})` })
            continue
          }
          const { data: blob, error: dlErr } = await supabaseAdmin.storage
            .from("onboarding-uploads")
            .download(cleanPath)
          if (dlErr || !blob) {
            steps.push({ step: `member_${mp.index}_passport`, status: "error", detail: dlErr?.message || "Download failed" })
            continue
          }
          const fileName = cleanPath.split("/").pop() || `passport_member_${mp.index}.pdf`
          const buffer = Buffer.from(await blob.arrayBuffer())
          const mimeType = blob.type || "application/octet-stream"
          const driveFile = await uploadBinaryToDrive(fileName, buffer, mimeType, companyContactsSubfolderId) as { id: string }
          await supabaseAdmin.from("documents").insert({
            file_name: fileName,
            drive_file_id: driveFile.id,
            drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
            document_type_name: "Passport",
            category: 2,
            category_name: "Contacts",
            status: "classified",
            contact_id: mp.contact_id,
            account_id: accountId,
            portal_visible: true,
          })
          steps.push({ step: `member_${mp.index}_passport`, status: "ok", detail: `Uploaded ${fileName}` })
        } catch (e) {
          steps.push({ step: `member_${mp.index}_passport`, status: "error", detail: e instanceof Error ? e.message : String(e) })
        }
      }
    }

    // 10. Update SD: link to account + update service_name.
    // eslint-disable-next-line no-restricted-syntax -- materialization writes to service_deliveries directly; central path
    const { data: updatedSds } = await supabaseAdmin
      .from("service_deliveries")
      .update({
        account_id: accountId,
        service_name: `Company Formation - ${chosenName}`,
        updated_at: new Date().toISOString(),
      })
      .eq("contact_id", params.contact_id)
      .eq("service_type", "Company Formation")
      .eq("status", "active")
      .select("id, source_offer_token")
    steps.push({
      step: "sd_link",
      status: "ok",
      detail: `${updatedSds?.length ?? 0} SD(s) linked to account`,
    })

    // 10d. Link the formation OFFER to the new account. The portal "Set up your
    // new company" banner (app/portal/page.tsx) shows for COMPLETED formation
    // offers with account_id IS NULL — once the company is real, that offer must
    // carry the account_id or the banner persists forever. Match by the SD's
    // source_offer_token (canonical link), falling back to the formation lead.
    // Best-effort — never fail materialization over a banner link.
    try {
      const offerTokens = (updatedSds ?? [])
        .map((s) => (s as { source_offer_token?: string | null }).source_offer_token)
        .filter((tok): tok is string => !!tok)
      let linkedOffers = 0
      if (offerTokens.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- central materialization path; clears the portal banner
        const { data: upd } = await supabaseAdmin
          .from("offers")
          .update({ account_id: accountId, updated_at: new Date().toISOString() })
          .in("token", offerTokens)
          .is("account_id", null)
          .select("token")
        linkedOffers = upd?.length ?? 0
      } else if (wp?.lead_id) {
        // eslint-disable-next-line no-restricted-syntax -- central materialization path; clears the portal banner
        const { data: upd } = await supabaseAdmin
          .from("offers")
          .update({ account_id: accountId, updated_at: new Date().toISOString() })
          .eq("lead_id", wp.lead_id)
          .eq("contract_type", "formation")
          .is("account_id", null)
          .select("token")
        linkedOffers = upd?.length ?? 0
      }
      steps.push({
        step: "offer_account_link",
        status: "ok",
        detail: `${linkedOffers} formation offer(s) linked to account ${offerTokens.length ? "(by token)" : wp?.lead_id ? "(by lead)" : "(no link available)"}`,
      })
    } catch (offerErr) {
      steps.push({
        step: "offer_account_link",
        status: "error",
        detail: offerErr instanceof Error ? offerErr.message : String(offerErr),
      })
    }

    // 10a. Backfill account_id on flow-stamped documents. The workspace "Filed
    // with State" stage uploads the Articles of Organization BEFORE the company
    // is materialized, so the documents row is stamped with the formation SD but
    // account_id=NULL (the SD had no account yet). Once the account exists, link
    // every such doc to it so it surfaces on the portal Documents page (which is
    // account-scoped). Unlike step 10c below, this matches by service_delivery_id
    // — flow uploads don't set document_type_name='Articles of Organization'.
    const linkedSdIds = (updatedSds ?? []).map(s => s.id as string)
    if (linkedSdIds.length > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_id not in generated types
        const { data: backfilled } = await (supabaseAdmin as any)
          .from("documents")
          .update({ account_id: accountId, updated_at: new Date().toISOString() })
          .in("service_delivery_id", linkedSdIds)
          .is("account_id", null)
          .select("id")
        steps.push({
          step: "flow_docs_account_backfill",
          status: "ok",
          detail: `${backfilled?.length ?? 0} flow document(s) linked to account`,
        })
      } catch (backfillErr) {
        steps.push({
          step: "flow_docs_account_backfill",
          status: "error",
          detail: backfillErr instanceof Error ? backfillErr.message : String(backfillErr),
        })
      }
    }

    // 10a-bis. Relocate flow-uploaded Articles that are still parked in Supabase
    // Storage into the company's Drive "1. Company" folder. The workspace
    // "Filed with State" upload happens BEFORE the company exists, so the binary
    // can't reach Drive at upload time — only a `storage:` documents pointer is
    // written (step 10a above just backfilled its account_id). Without this the
    // Articles never land in Drive AND the signed-SS-4 IRS merge (which scans
    // the Drive "1. Company" folder) can't find them, producing an SS-4-only fax
    // package (Art of Profit Academy / Numero Uno Social / Automatiko,
    // 2026-07-08). Best-effort + idempotent — never fails materialization.
    if (companyDocsSubfolderId && linkedSdIds.length > 0) {
      try {
        const { relocateFormationFlowDocs } = await import("@/lib/flows/relocate-flow-storage-docs")
        const rel = await relocateFormationFlowDocs({
          companySubfolderId: companyDocsSubfolderId,
          serviceDeliveryIds: linkedSdIds,
        })
        steps.push({
          step: "flow_docs_to_drive",
          status: rel.errors.length > 0 ? "error" : "ok",
          detail: `${rel.relocated} relocated, ${rel.skipped} skipped${rel.errors.length > 0 ? ` — errors: ${rel.errors.join("; ")}` : ""}`,
        })
      } catch (relErr) {
        steps.push({
          step: "flow_docs_to_drive",
          status: "error",
          detail: relErr instanceof Error ? relErr.message : String(relErr),
        })
      }
    }

    // 10b. Self-heal: if we got here via wizard_progress fallback (no
    // formation_submissions row existed), write the canonical row now so
    // future audits, re-runs, and any code that queries formation_submissions
    // see a consistent record. Token follows wizard-submit's portal-{slug}-{year}
    // convention; conflict-on-token is benign (someone else's row with the same
    // slug — leave it alone, we still proceeded successfully).
    if (resolverSource === "wizard_progress" && !submissionId) {
      try {
        const ownerFullName = [submitted.owner_first_name, submitted.owner_last_name]
          .filter(Boolean).map(String).join(" ")
        const slugSource = (ownerFullName || chosenName || "client").toLowerCase()
        const nameSlug = slugSource.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").slice(0, 40)
        const year = new Date(formationDate).getFullYear() || new Date().getFullYear()
        const selfHealToken = `portal-${nameSlug}-${year}-heal`

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- types lag the column set
        const healRow: Record<string, unknown> = {
          token: selfHealToken,
          contact_id: params.contact_id,
          language: "en",
          prefilled_data: {},
          submitted_data: submitted,
          changed_fields: {},
          upload_paths: uploadPaths,
          status: "completed",
          state: resolvedStateRaw,
          // The RESOLVED code (contract-first), never a default — the LUMA
          // incident's self-heal wrote an invented 'SMLLC' here, which made
          // the wrong value look authoritative to every later reader.
          entity_type: resolvedEntityCode,
          completed_at: new Date().toISOString(),
        }
        // Plain INSERT — formation_submissions.token has no unique index, so
        // upsert with onConflict:'token' raises 42P10. The -heal suffix already
        // makes the token unique to this materialization; race is implausible
        // (materialize runs serially per contact via the Upload Articles UX).
        const { error: healErr } = await supabaseAdmin
          .from("formation_submissions")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- types lag the column set
          .insert(healRow as any)
        steps.push({
          step: "self_heal_submission",
          status: healErr ? "error" : "ok",
          detail: healErr ? healErr.message : `formation_submissions row created (token=${selfHealToken}, state=${resolvedStateRaw})`,
        })
      } catch (healErr) {
        steps.push({
          step: "self_heal_submission",
          status: "error",
          detail: healErr instanceof Error ? healErr.message : String(healErr),
        })
      }
    }

    // 10c. Orphan documents cleanup. When materialize was retried after one or
    // more failed attempts, each attempt created a "Articles of Organization"
    // documents row with account_id=null (see upload-articles route). Link the
    // most recent one to the new account and remove the duplicate documents
    // rows (Drive files stay — admin can clean those up manually if needed;
    // we only own the CRM-side documents record here).
    try {
      const { data: orphanDocs } = await supabaseAdmin
        .from("documents")
        .select("id, drive_file_id, created_at")
        .eq("contact_id", params.contact_id)
        .eq("document_type_name", "Articles of Organization")
        .is("account_id", null)
        .order("created_at", { ascending: false })
      if (orphanDocs && orphanDocs.length > 0) {
        const [keep, ...drop] = orphanDocs
        // Link the newest to the new account.
        await supabaseAdmin
          .from("documents")
          .update({ account_id: accountId, updated_at: new Date().toISOString() })
          .eq("id", keep.id)
        let dropped = 0
        if (drop.length > 0) {
          const dropIds = drop.map(d => d.id)
          const { error: delErr } = await supabaseAdmin.from("documents").delete().in("id", dropIds)
          if (!delErr) dropped = dropIds.length
        }
        steps.push({
          step: "orphan_documents_cleanup",
          status: "ok",
          detail: `Kept Articles document ${keep.id.slice(0, 8)} (drive ${keep.drive_file_id?.slice(0, 8) ?? "n/a"})${dropped > 0 ? `, deleted ${dropped} duplicate(s)` : ""}`,
        })
      }
    } catch (dedupeErr) {
      steps.push({
        step: "orphan_documents_cleanup",
        status: "error",
        detail: dedupeErr instanceof Error ? dedupeErr.message : String(dedupeErr),
      })
    }

    // 11. Sync portal tier.
    // allowDowngrade:true is REQUIRED here: accounts.portal_tier defaults to
    // 'active' at insert, so a plain syncTier('formation') is treated as a
    // downgrade and silently no-ops, leaving a just-formed company wrongly at
    // 'active'. Forcing 'formation' is correct because materialization always
    // runs BEFORE the EIN exists (the account is created here; EIN is recorded
    // on it afterwards), and the "already_materialized" guard above prevents a
    // re-run from ever touching an account that has since gone active. The
    // contact-tier cascade inside syncTier still uses computeContactTier (MAX
    // across the contact's accounts), so a returning client who already owns an
    // active company keeps their 'active' contact tier — only the new company's
    // account row becomes 'formation'.
    try {
      const tierResult = await syncTier({
        accountId,
        newTier: "formation",
        allowDowngrade: true,
        reason: "company materialized from Articles of Organization",
        actor,
      })
      steps.push({
        step: "tier_sync",
        status: tierResult.success ? "ok" : "error",
        detail: tierResult.success ? `${tierResult.previousTier ?? "lead"} → formation` : tierResult.error,
      })
    } catch (tierErr) {
      steps.push({ step: "tier_sync", status: "error", detail: tierErr instanceof Error ? tierErr.message : String(tierErr) })
    }

    // 12. SS-4 next-step indicator. ss4_create requires registered_agent_id
    // with a county-set address (lib/mcp/tools/ss4.ts:240). Auto-fire is a
    // future refinement — admin runs ss4_create from MCP after RA is set.
    steps.push({
      step: "ss4_pending",
      status: "skipped",
      detail: params.registered_agent_id
        ? "Run ss4_create on the new account to start the EIN application"
        : "Set Registered Agent first, then run ss4_create",
    })

    // 13. Audit log.
    await logAction({
      actor,
      action_type: "materialize_formation_company",
      table_name: "accounts",
      record_id: accountId,
      account_id: accountId,
      contact_id: params.contact_id,
      summary: `Formation company materialized: ${chosenName} (${entityType}, ${stateName})`,
      details: {
        formation_date: formationDate,
        filing_id: params.filing_id ?? null,
        registered_agent_id: params.registered_agent_id ?? null,
        steps: steps.map(s => ({ step: s.step, status: s.status, detail: s.detail })),
      },
    })

    return { success: true, outcome: "materialized", account_id: accountId, steps }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      steps,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
