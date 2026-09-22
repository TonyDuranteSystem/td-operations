/**
 * applyOnboardingReview — the actual CRM-setup logic behind confirming an
 * onboarding submission: creates/updates the Contact and Account, links
 * them, derives renewal dates, upgrades the portal tier, and enqueues the
 * background job (Drive folder, lease draft, tasks, tax returns).
 *
 * Extracted (2026-09-20, dev job bc2a8f7f) from the `onboarding_form_review`
 * MCP tool's `apply_changes=true` branch in `lib/mcp/tools/onboarding.ts` —
 * a byte-for-byte move of the existing, already-battle-tested logic, NOT a
 * rewrite. It is now callable from both the MCP tool (chat) and a new
 * dashboard API route (the staff review-inbox "Confirm" button), so staff
 * have one real path instead of only a chat command.
 *
 * Idempotency: same pattern as approveAndApplyBankingReview /
 * approveAndApplyTaxReview / approveAndApplyClosureReview — short-circuit on
 * `reviewed_at`, then atomically claim the lock with
 * `UPDATE ... WHERE reviewed_at IS NULL` BEFORE any Contact/Account INSERT
 * runs, so a double-click/double-tap (a real risk on Antonio's mobile PWA)
 * cannot create duplicate records. See CLAUDE.md's TOCTOU pattern note.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface ApplyOnboardingReviewResult {
  ok: boolean
  alreadyApplied: boolean
  error?: string
  lines: string[]
  contact_id: string | null
  account_id: string | null
  company_name: string | null
  /** True when the Account/Contact are not created yet because setup runs
   * in a background job (the real portal-wizard path) rather than inline —
   * the UI must not claim "created" when this is true. */
  pending?: boolean
}

export async function applyOnboardingReview(
  submission_id: string,
  actor: string,
): Promise<ApplyOnboardingReviewResult> {
  const lines: string[] = []

  // ── 1. Load submission + early short-circuit on reviewed_at ──────────
  const { data: sub, error: subErr } = await supabaseAdmin
    .from("onboarding_submissions")
    .select("*")
    .eq("id", submission_id)
    .maybeSingle()
  if (subErr) {
    return { ok: false, alreadyApplied: false, error: `onboarding_submissions lookup failed: ${subErr.message}`, lines, contact_id: null, account_id: null, company_name: null }
  }
  if (!sub) {
    return { ok: false, alreadyApplied: false, error: `onboarding_submissions row not found for id ${submission_id}`, lines, contact_id: null, account_id: null, company_name: null }
  }
  if (sub.status !== "completed") {
    return { ok: false, alreadyApplied: false, error: `Submission is not completed (status='${sub.status}') — cannot apply`, lines, contact_id: null, account_id: null, company_name: null }
  }

  const token = sub.token as string
  const submitted = (sub.submitted_data as Record<string, unknown>) || {}
  const companyNamePreview = String(submitted.company_name || "").trim()

  if (sub.reviewed_at) {
    return {
      ok: true,
      alreadyApplied: true,
      lines: [`⚠️ Already reviewed at ${sub.reviewed_at} by ${sub.reviewed_by || "unknown"}. No changes applied.`],
      contact_id: sub.contact_id || null,
      account_id: sub.account_id || null,
      company_name: companyNamePreview || null,
    }
  }

  // ── 2. Win the idempotency lock BEFORE any Contact/Account write ─────
  const { data: lockRows, error: lockErr } = await supabaseAdmin
    .from("onboarding_submissions")
    .update({ reviewed_at: new Date().toISOString(), reviewed_by: actor })
    .eq("id", sub.id)
    .is("reviewed_at", null)
    .select("id")
  if (lockErr) {
    return { ok: false, alreadyApplied: false, error: `Failed to acquire review lock: ${lockErr.message}`, lines, contact_id: null, account_id: null, company_name: null }
  }
  if (!lockRows || lockRows.length === 0) {
    return {
      ok: true,
      alreadyApplied: true,
      lines: [`⚠️ Another review just started for this submission. No changes applied.`],
      contact_id: sub.contact_id || null,
      account_id: sub.account_id || null,
      company_name: companyNamePreview || null,
    }
  }

  const now = new Date().toISOString()
  const entityTypeMapped = sub.entity_type === "SMLLC" ? "Single Member LLC" : "Multi Member LLC"
  const companyName = String(submitted.company_name || "").trim()
  const stateOfFormation = String(submitted.state_of_formation || sub.state || "").trim()
  let contactId: string | null = sub.contact_id || null
  let accountId: string | null = sub.account_id || null

  // ═══════════════════════════════════════════════
  // PHASE 1: FAST (inline) — Contact + Account + Link
  // ═══════════════════════════════════════════════

  // ─── 1. CONTACT: find/create/update ───
  try {
    if (!contactId && submitted.owner_email) {
      const { data: existingContact } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .eq("email", String(submitted.owner_email))
        .maybeSingle()
      if (existingContact) contactId = existingContact.id
    }

    const ownerFullName = [submitted.owner_first_name, submitted.owner_last_name].filter(Boolean).join(" ").trim()
    const contactFields: Record<string, unknown> = {}
    if (submitted.owner_first_name) contactFields.first_name = submitted.owner_first_name
    if (submitted.owner_last_name) contactFields.last_name = submitted.owner_last_name
    if (ownerFullName) contactFields.full_name = ownerFullName
    if (submitted.owner_email) contactFields.email = submitted.owner_email
    if (submitted.owner_phone) contactFields.phone = submitted.owner_phone
    if (submitted.owner_nationality) contactFields.citizenship = submitted.owner_nationality
    // Dual-write address: structured fields (primary) + residency
    // concat (legacy readers). address_country stores the country
    // only; residency gets the full concat for backward compat.
    if (submitted.owner_street) contactFields.address_line1 = String(submitted.owner_street).trim()
    if (submitted.owner_city) contactFields.address_city = String(submitted.owner_city).trim()
    if (submitted.owner_state_province) contactFields.address_state = String(submitted.owner_state_province).trim()
    if (submitted.owner_zip) contactFields.address_zip = String(submitted.owner_zip).trim()
    if (submitted.owner_country) contactFields.address_country = String(submitted.owner_country).trim()
    const addrPartsOb = [
      submitted.owner_street,
      submitted.owner_city,
      submitted.owner_state_province,
      submitted.owner_zip,
      submitted.owner_country,
    ].filter(Boolean).map(String).map(s => s.trim())
    if (addrPartsOb.length > 0) contactFields.residency = addrPartsOb.join(", ")
    if (submitted.owner_dob) contactFields.date_of_birth = submitted.owner_dob
    if (submitted.owner_itin) contactFields.itin_number = submitted.owner_itin
    if (submitted.owner_itin_issue_date) contactFields.itin_issue_date = submitted.owner_itin_issue_date
    contactFields.updated_at = now

    if (contactId) {
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { error: upErr } = await supabaseAdmin
        .from("contacts")
        .update(contactFields)
        .eq("id", contactId)
      if (upErr) {
        lines.push(`❌ Contact update failed: ${upErr.message}`)
      } else {
        lines.push(`✅ Contact updated (${contactId})`)
      }
    } else {
      if (!ownerFullName) throw new Error("Cannot create contact: owner name is empty")
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { data: newContact, error: createErr } = await supabaseAdmin
        .from("contacts")
        .insert({ ...contactFields, status: "Active" } as never)
        .select("id")
        .single()
      if (createErr || !newContact) {
        lines.push(`❌ Contact creation failed: ${createErr?.message || "unknown error"}`)
      } else {
        contactId = newContact.id
        lines.push(`✅ Contact CREATED (${contactId}): ${ownerFullName}`)
      }
    }
  } catch (e) {
    lines.push(`❌ Contact step failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ─── 2. ACCOUNT: find/create/update ───
  // Also: services_bundle from offer, account_type, ra_renewal_date
  let servicesBundlePopulated = false
  try {
    if (!accountId && companyName) {
      // Escape ILIKE wildcard metacharacters in the client-submitted company
      // name (2026-09-20, bug-hunter finding) — an unescaped "%" or "_" in a
      // real business name (e.g. "100% Green Solutions LLC") would otherwise
      // turn this into a wildcard pattern that could match a DIFFERENT,
      // unrelated existing account, silently attaching this submission's
      // data to a stranger's account.
      const escapedCompanyName = companyName.replace(/[\\%_]/g, (c) => `\\${c}`)
      const { data: existingAcct } = await supabaseAdmin
        .from("accounts")
        .select("id")
        .ilike("company_name", escapedCompanyName)
        .maybeSingle()
      if (existingAcct) accountId = existingAcct.id
    }

    const acctFields: Record<string, unknown> = {}
    if (companyName) acctFields.company_name = companyName
    if (submitted.ein) acctFields.ein_number = submitted.ein
    if (stateOfFormation) acctFields.state_of_formation = stateOfFormation
    if (submitted.formation_date) acctFields.formation_date = submitted.formation_date
    if (submitted.filing_id) acctFields.filing_id = submitted.filing_id
    acctFields.entity_type = entityTypeMapped
    // Client Since = the staff-confirm moment (Antonio, 2026-09-20, dev job
    // bc2a8f7f) — this is when TD actually starts being responsible for the
    // client, so it's the correct auto-stamp trigger, replacing the old
    // manual-entry-only field. RA Switch Date is DELIBERATELY NOT stamped
    // here anymore: it used to be set to "today" at this same moment, which
    // is exactly the bug the Calendar false-positive fix (dev job cdbb9bf3,
    // same session) was about — RA Switch Date must reflect the actual day
    // the Harbor Compliance switch completes, a separate, later staff action
    // (Option B, manual-confirm — not yet built). Until that step exists,
    // renewal-date derivation below correctly falls back to client_since
    // (deriveRenewalDates's own existing ra_switch_date || client_since
    // chain), which is more accurate than the old always-today stamp.
    acctFields.client_since = now.slice(0, 10)
    acctFields.updated_at = now

    // ─── Referral propagation: lead/offer → account ───
    if (sub.lead_id) {
      try {
        const { data: lead } = await supabaseAdmin
          .from("leads")
          .select("referrer_name, referrer_partner_id, source")
          .eq("id", sub.lead_id)
          .maybeSingle()

        if (lead?.referrer_name) {
          // Check offer for detailed referral info
          const { data: offer } = await supabaseAdmin
            .from("offers")
            .select("referrer_name, referrer_type, referrer_account_id, referrer_commission_type, referrer_commission_pct, referrer_agreed_price")
            .eq("lead_id", sub.lead_id)
            .not("referrer_name", "is", null)
            .limit(1)
            .maybeSingle()

          acctFields.referrer = offer?.referrer_name || lead.referrer_name
          acctFields.referred_by = offer?.referrer_account_id || lead.referrer_partner_id || null
          acctFields.referral_commission_pct = offer?.referrer_commission_pct ?? 10
          acctFields.referral_status = "pending"
          lines.push(`📎 Referral: ${acctFields.referrer} (${offer?.referrer_type || "client"}, ${acctFields.referral_commission_pct}%) → status: pending`)
        }
      } catch (refErr) {
        lines.push(`⚠️ Referral lookup failed: ${refErr instanceof Error ? refErr.message : String(refErr)}`)
      }
    }

    // Derive account_type + installments + services_bundle from CONTRACTS (source of truth)
    let derivedAccountType = "Client" // default

    // Find the signed contract via offer linked to this lead
    if (sub.lead_id) {
      const { data: contract } = await supabaseAdmin
        .from("contracts")
        .select("annual_fee, installments, llc_type, offer_token")
        .eq("offer_token", (
          await supabaseAdmin
            .from("offers")
            .select("token")
            .eq("lead_id", sub.lead_id)
            .eq("status", "signed")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        ).data?.token || "__none__")
        .eq("status", "signed")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (contract) {
        // Parse installments from contract JSON {"jan":1000,"jun":1000}
        let instJan = 0, instJun = 0
        if (contract.installments) {
          try {
            const inst = typeof contract.installments === "string"
              ? JSON.parse(contract.installments) : contract.installments
            instJan = inst.jan || 0
            instJun = inst.jun || 0
          } catch { /* ignore parse errors */ }
        }

        if (instJan > 0) acctFields.installment_1_amount = instJan
        if (instJun > 0) acctFields.installment_2_amount = instJun
        if (instJan > 0 || instJun > 0) {
          // Determine currency from annual_fee format or default USD
          acctFields.installment_1_currency = "USD"
          acctFields.installment_2_currency = "USD"
        }

        const hasAnnual = instJan > 0 || instJun > 0
          || (contract.annual_fee && parseFloat(contract.annual_fee) > 0)
        derivedAccountType = hasAnnual ? "Client" : "One-Time"
      }

      // Populate services_bundle from offer
      const { data: offer } = await supabaseAdmin
        .from("offers")
        .select("services, additional_services")
        .eq("lead_id", sub.lead_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (offer) {
        const allServices: string[] = []
        const svcList = Array.isArray(offer.services) ? offer.services
          : (typeof offer.services === "string" ? JSON.parse(offer.services) : [])
        for (const s of svcList) {
          const svc = s as Record<string, unknown>
          if (svc.name) allServices.push(String(svc.name))
        }
        if (offer.additional_services && Array.isArray(offer.additional_services)) {
          for (const s of offer.additional_services) {
            const svc = s as Record<string, unknown>
            if (svc.name) allServices.push(String(svc.name))
          }
        }
        if (allServices.length > 0) {
          acctFields.services_bundle = allServices.join(", ")
          servicesBundlePopulated = true
        }
      }
    }
    acctFields.account_type = derivedAccountType

    if (accountId) {
      // Re-runs must not move an already-recorded Client Since date
      // (billing derives the TD-start from it — same reasoning that used to
      // protect ra_switch_date here, now applied to client_since instead).
      const { data: existingAcct } = await supabaseAdmin
        .from("accounts")
        .select("client_since")
        .eq("id", accountId)
        .maybeSingle()
      if (existingAcct?.client_since) delete acctFields.client_since
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { error: acctErr } = await supabaseAdmin
        .from("accounts")
        .update(acctFields)
        .eq("id", accountId)
      if (acctErr) {
        lines.push(`❌ Account update failed: ${acctErr.message}`)
      } else {
        lines.push(`✅ Account updated (${accountId})`)
      }
    } else {
      if (!companyName) throw new Error("Cannot create account: company name is empty")
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { data: newAcct, error: acctCreateErr } = await supabaseAdmin
        .from("accounts")
        .insert({ ...acctFields, status: "Active" } as never)
        .select("id")
        .single()
      if (acctCreateErr || !newAcct) {
        lines.push(`❌ Account creation failed: ${acctCreateErr?.message || "unknown error"}`)
      } else {
        accountId = newAcct.id
        lines.push(`✅ Account CREATED (${accountId}): ${companyName}`)
        // portal_tier defaults to 'active' at the DATABASE level on insert
        // (2026-09-20, found while verifying the bug-hunter fix above) — left
        // alone, a brand-new account gets live portal access the instant
        // it's created, even if the Contact step fails right after and
        // nothing else gets set up. Same problem, same fix already
        // established by Formation's materialize step
        // (lib/operations/formation-materialize.ts): force it down through
        // syncTier() with allowDowngrade — a plain syncTier() call would
        // treat 'active' → 'onboarding' as a downgrade and silently no-op,
        // per R102 ("all writes MUST go through syncTier()", never a direct
        // column write). The later guarded syncTier() call (requires BOTH
        // contactId AND accountId) is the only thing allowed to promote it
        // back to 'active' once everything genuinely succeeded.
        const { syncTier: pinPortalTier } = await import("@/lib/operations/sync-tier")
        await pinPortalTier({
          accountId,
          newTier: "onboarding",
          allowDowngrade: true,
          reason: "onboarding review — account created, awaiting full setup",
        })
      }
    }
    if (servicesBundlePopulated) lines.push(`✅ services_bundle populated from offer`)
    lines.push(`✅ account_type = ${derivedAccountType} (from offer)`)

    // Renewal dates — anniversary derivation, null-only, shared helper
    // (plan c2d97552 B2d; replaces the old ra_renewal_date=today write).
    if (accountId) {
      try {
        const { data: acctNow } = await supabaseAdmin
          .from("accounts")
          .select("ra_renewal_date, cmra_renewal_date, annual_report_due_date, ra_switch_date, client_since, formation_date, state_of_formation")
          .eq("id", accountId)
          .single()
        if (acctNow) {
          const { deriveRenewalDates, applyRenewalDateFills } = await import("@/lib/operations/renewal-dates")
          const fills = deriveRenewalDates({
            intake: "onboarding",
            formation_date: acctNow.formation_date,
            ra_switch_date: acctNow.ra_switch_date,
            client_since: acctNow.client_since,
            state_of_formation: acctNow.state_of_formation,
            existing: {
              ra_renewal_date: acctNow.ra_renewal_date,
              annual_report_due_date: acctNow.annual_report_due_date,
              cmra_renewal_date: acctNow.cmra_renewal_date,
            },
          })
          const appliedDates = await applyRenewalDateFills(accountId, fills, {
            state: acctNow.state_of_formation,
            actor: "onboarding-review",
          })
          if (appliedDates.length) lines.push(`✅ Renewal dates: ${appliedDates.join(", ")}`)
        }
      } catch (rdErr) {
        lines.push(`⚠️ Renewal-date derivation failed: ${rdErr instanceof Error ? rdErr.message : String(rdErr)}`)
      }
    }
  } catch (e) {
    lines.push(`❌ Account step failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ─── 3. LINK Contact <-> Account ───
  if (contactId && accountId) {
    try {
      const { data: existingLink } = await supabaseAdmin
        .from("account_contacts")
        .select("account_id")
        .eq("account_id", accountId)
        .eq("contact_id", contactId)
        .maybeSingle()
      if (existingLink) {
        lines.push(`✅ Contact-Account link already exists`)
      } else {
        const { error: linkErr } = await supabaseAdmin
          .from("account_contacts")
          .insert({ account_id: accountId, contact_id: contactId, role: "Owner" })
        if (linkErr) {
          lines.push(`❌ Contact-Account link failed: ${linkErr.message}`)
        } else {
          lines.push(`✅ Contact linked to Account (role: Owner)`)
        }
      }
    } catch (e) {
      lines.push(`❌ Link step failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ═══════════════════════════════════════════════
  // PHASE 2: SLOW (async job) — Drive, Lease, Tasks, Tax, Portal, Lead, Form
  // ═══════════════════════════════════════════════

  if (contactId && accountId) {
    try {
      const { enqueueJob } = await import("@/lib/jobs/queue")
      const { id: jobId } = await enqueueJob({
        job_type: "onboarding_setup",
        payload: {
          token,
          submission_id: sub.id,
          account_id: accountId,
          contact_id: contactId,
          lead_id: sub.lead_id,
          company_name: companyName,
          state_of_formation: stateOfFormation,
          entity_type: sub.entity_type,
          submitted_data: submitted,
          upload_paths: sub.upload_paths,
        },
        priority: 1,  // Highest priority
        account_id: accountId,
        lead_id: sub.lead_id || undefined,
        related_entity_type: "onboarding_submission",
        related_entity_id: sub.id,
      })

      lines.push("")
      lines.push(`🚀 Background job enqueued: ${jobId}`)
      lines.push(`   Type: onboarding_setup`)
      lines.push(`   Steps: Drive folder + doc copy, Lease, Tasks, Tax returns, Portal, Lead→Converted, Form→reviewed`)
      lines.push(`   ➡️ Check progress: job_status('${jobId}')`)
    } catch (e) {
      lines.push(`❌ Job enqueue failed: ${e instanceof Error ? e.message : String(e)}`)
      lines.push(`⚠️ Falling back to inline execution is NOT available. Re-run this tool after fixing the issue.`)
    }
  } else {
    lines.push(`⚠️ Cannot enqueue background job: missing contact_id (${contactId}) or account_id (${accountId})`)
  }

  // Upgrade portal tier: onboarding → active. Requires BOTH ids (2026-09-20,
  // bug-hunter blocker finding): upgrading a client to "active" off a
  // half-created record (e.g. account exists, contact creation threw) would
  // silently misrepresent their real state — was previously gated on
  // accountId alone.
  if (contactId && accountId) {
    const { syncTier } = await import("@/lib/operations/sync-tier")
    await syncTier({ accountId, newTier: 'active', reason: 'onboarding review completed' })
    lines.push(`🔓 Portal tier upgraded: onboarding → active`)
  }

  // Summary
  lines.push("")
  lines.push("───────────────────────────────────")
  lines.push("SUMMARY")
  lines.push(`   Contact: ${contactId || "FAILED"}`)
  lines.push(`   Account: ${accountId || "FAILED"}`)
  lines.push(`   Company: ${companyName || "(unknown)"}`)
  lines.push(`   Background job: Drive, Lease, Tasks, Tax, Portal, Lead, Form`)

  // Partial failure (2026-09-20, bug-hunter blocker finding): the lock is
  // already claimed by this point (by design, for the double-click fix), so
  // this submission will NOT re-run automatically — that's correct, since a
  // second attempt must not re-create a Contact/Account that already exists.
  // But it must NEVER be reported as a plain success: caller (the dashboard
  // button and the chat tool) must both see this as a real failure needing a
  // human to look at the actual `lines` output and fix the submitted data,
  // not "Confirmed" with the client silently missing a Drive folder, lease,
  // tasks, and tax-return setup.
  if (!contactId || !accountId) {
    return {
      ok: false,
      alreadyApplied: false,
      error: `Incomplete: ${!contactId ? "no Contact" : "Contact ok"}, ${!accountId ? "no Account" : "Account ok"}. Nothing further was set up (no Drive folder, lease, tasks, or portal-tier change). The submission is now locked as reviewed — see the detail lines for what actually failed, fix the underlying data, then re-open it manually.`,
      lines,
      contact_id: contactId,
      account_id: accountId,
      company_name: companyName || null,
    }
  }

  return {
    ok: true,
    alreadyApplied: false,
    lines,
    contact_id: contactId,
    account_id: accountId,
    company_name: companyName || null,
  }
}

/**
 * confirmPortalWizardOnboarding — the Confirm action for a submission from
 * the REAL client journey (logged-in portal wizard, source='portal_wizard'),
 * as opposed to applyOnboardingReview above which is shaped for the
 * separate manual token-link tool.
 *
 * This does NOT create the Contact/Account inline — that already happened
 * (Contact, at least) or will happen inside the onboarding_setup job itself
 * (createAccountFromWizard), which is the job's own established,
 * wizard-specific logic (handles invoice/payment backfill onto the new
 * account, etc.) — duplicating it here would be a second, divergent
 * account-creation path for the same data. Instead this just: records WHO
 * reviewed it and WHEN, then re-enqueues the same job that already ran once
 * and stopped at the staff-review gate (lib/jobs/handlers/onboarding-setup.ts)
 * — this time with reviewed_at already set, so the gate passes and the job
 * runs the rest of the chain (Account, Drive, tasks, tax return; lease/OA
 * stay behind their own separate, already-off switch).
 *
 * Same idempotency shape as applyOnboardingReview: short-circuit on
 * reviewed_at, then atomically claim the lock before any write.
 */
export async function confirmPortalWizardOnboarding(
  submission_id: string,
  actor: string,
): Promise<ApplyOnboardingReviewResult> {
  const lines: string[] = []

  const { data: sub, error: subErr } = await supabaseAdmin
    .from("onboarding_submissions")
    .select("*")
    .eq("id", submission_id)
    .maybeSingle()
  if (subErr) {
    return { ok: false, alreadyApplied: false, error: `onboarding_submissions lookup failed: ${subErr.message}`, lines, contact_id: null, account_id: null, company_name: null }
  }
  if (!sub) {
    return { ok: false, alreadyApplied: false, error: `onboarding_submissions row not found for id ${submission_id}`, lines, contact_id: null, account_id: null, company_name: null }
  }
  if (sub.source !== "portal_wizard") {
    return { ok: false, alreadyApplied: false, error: `Submission ${submission_id} is not a portal-wizard submission (source='${sub.source}') — use the standard confirm action instead`, lines, contact_id: null, account_id: null, company_name: null }
  }
  if (sub.status !== "completed") {
    return { ok: false, alreadyApplied: false, error: `Submission is not completed (status='${sub.status}') — cannot confirm`, lines, contact_id: null, account_id: null, company_name: null }
  }

  const submitted = (sub.submitted_data as Record<string, unknown>) || {}
  const companyName = String(submitted.company_name || "").trim()

  if (sub.reviewed_at) {
    return {
      ok: true,
      alreadyApplied: true,
      lines: [`⚠️ Already reviewed at ${sub.reviewed_at} by ${sub.reviewed_by || "unknown"}. No changes applied.`],
      contact_id: sub.contact_id || null,
      account_id: sub.account_id || null,
      company_name: companyName || null,
    }
  }

  // Win the idempotency lock BEFORE anything else — same TOCTOU pattern as
  // applyOnboardingReview (CLAUDE.md's shared idempotency-lock convention).
  const { data: lockRows, error: lockErr } = await supabaseAdmin
    .from("onboarding_submissions")
    .update({ reviewed_at: new Date().toISOString(), reviewed_by: actor })
    .eq("id", sub.id)
    .is("reviewed_at", null)
    .select("id")
  if (lockErr) {
    return { ok: false, alreadyApplied: false, error: `Failed to acquire review lock: ${lockErr.message}`, lines, contact_id: null, account_id: null, company_name: null }
  }
  if (!lockRows || lockRows.length === 0) {
    return {
      ok: true,
      alreadyApplied: true,
      lines: [`⚠️ Another review just started for this submission. No changes applied.`],
      contact_id: sub.contact_id || null,
      account_id: sub.account_id || null,
      company_name: companyName || null,
    }
  }

  lines.push(`✅ Marked reviewed by ${actor}`)

  const stateOfFormation = String(submitted.state_of_formation || sub.state || "").trim()

  try {
    const { enqueueJob } = await import("@/lib/jobs/queue")
    const { id: jobId } = await enqueueJob({
      job_type: "onboarding_setup",
      payload: {
        token: sub.token,
        submission_id: sub.id,
        account_id: sub.account_id,
        contact_id: sub.contact_id,
        lead_id: sub.lead_id,
        company_name: companyName,
        state_of_formation: stateOfFormation,
        entity_type: sub.entity_type,
        submitted_data: submitted,
        upload_paths: sub.upload_paths,
        // source intentionally omitted — this run must pass the staff
        // review gate now that reviewed_at is set above.
      },
      priority: 1,
      account_id: sub.account_id || undefined,
      lead_id: sub.lead_id || undefined,
      related_entity_type: "onboarding_submission",
      related_entity_id: sub.id,
    })

    lines.push(`🚀 Setup job enqueued: ${jobId}`)
    lines.push(`   Will create: ${sub.account_id ? "(account already exists)" : "Account"}, Drive folder, follow-up tasks, tax return (if applicable)`)
    lines.push(`   Lease and Operating Agreement stay manual — not created automatically.`)
  } catch (e) {
    // Compensating rollback (bug-hunter finding, 2026-09-20): the lock above
    // already claimed reviewed_at, so without this the submission drops out
    // of the review-inbox query (which filters reviewed_at IS NULL) forever,
    // with no self-service way for staff to retry — only a raw job tool or
    // an engineer could recover it. Clearing reviewed_at/reviewed_by here
    // undoes the lock claim (nothing else was written) so the row reappears
    // in the same review-inbox screen and staff can just click Confirm again.
    await supabaseAdmin
      .from("onboarding_submissions")
      .update({ reviewed_at: null, reviewed_by: null })
      .eq("id", sub.id)

    return {
      ok: false,
      alreadyApplied: false,
      error: `Setup job failed to enqueue: ${e instanceof Error ? e.message : String(e)}. This submission is back in the review queue — try Confirm again.`,
      lines,
      contact_id: sub.contact_id || null,
      account_id: sub.account_id || null,
      company_name: companyName || null,
    }
  }

  return {
    ok: true,
    alreadyApplied: false,
    lines,
    contact_id: sub.contact_id || null,
    account_id: sub.account_id || null,
    company_name: companyName || null,
    // Setup runs in the background job just enqueued — nothing is created yet.
    pending: !sub.account_id,
  }
}
