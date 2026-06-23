/**
 * Job Handler: welcome_package_prepare
 *
 * Auto-triggered when Company Formation SD advances to "Articles Received"
 * (7-stage v2 pipeline; also re-enqueued idempotently by the EIN-received handlers).
 * Reuses the welcome-package MCP tool logic:
 * - Creates OA (if not exists)
 * - Creates Lease (if not exists)
 * - Creates Relay + Payset banking forms
 * - Finds EIN letter + Articles on Drive
 * - Generates welcome email draft
 * - Updates account.welcome_package_status
 *
 * Does NOT send email. Creates a task for Antonio to review + send.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { OA_SUPPORTED_STATES } from "@/lib/types/oa-templates"
import { updateJobProgress, type Job, type JobResult } from "../queue"
import { APP_BASE_URL } from "@/lib/config"
import type { Json } from "@/lib/database.types"

interface WelcomePackagePayload {
  account_id: string
  suite_number?: string
  /**
   * Bug 3 fix (master 9e27e14f, sysdoc ops-2026-05-07-onetime-to-active-journey-fix-plan):
   *
   * The handler was originally Formation Stage 3.11 only — it celebrates an
   * EIN that just arrived after fresh LLC formation and tells the client
   * banking is now available. When the onboarding wizard handler started
   * enqueuing this same job (to reuse the OA / Lease / Relay / Payset /
   * email-draft scaffolding), the celebration message was sent to clients
   * whose EIN was issued long ago — factually wrong and confusing.
   *
   * Pass `context: 'onboarding'` from the onboarding wizard handler. The
   * message + push notification at Step 9 will then use onboarding wording
   * ("Your onboarding is being processed...") instead of the Formation EIN
   * celebration. Default ('formation' or undefined) keeps existing behavior
   * — important: `record-ein-received` must NOT pass this flag so the
   * Formation EIN celebration still fires correctly when EIN actually
   * arrives in the Formation flow.
   */
  context?: "formation" | "onboarding"
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

const _BASE_URL = APP_BASE_URL

export async function handleWelcomePackagePrepare(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as WelcomePackagePayload
  const result: JobResult = { steps: [] }
  const today = new Date().toISOString().slice(0, 10)
  const _now = new Date().toISOString()
  const year = new Date().getFullYear()

  // ─── 1. FETCH ACCOUNT ───
  const { data: account, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, ein_number, state_of_formation, formation_date, physical_address, registered_agent_address, registered_agent_provider, drive_folder_id, welcome_package_status, entity_type")
    .eq("id", p.account_id)
    .single()

  if (accErr || !account) {
    result.steps.push(step("fetch_account", "error", accErr?.message || "Account not found"))
    result.summary = "Failed: account not found"
    result.ok = false
    return result
  }

  // Skip if already prepared
  if (account.welcome_package_status) {
    result.steps.push(step("check_status", "skipped", `Already ${account.welcome_package_status}`))
    result.summary = "Skipped: already prepared"
    return result
  }

  if (!account.ein_number) {
    result.steps.push(step("check_ein", "skipped", "No EIN on account yet"))
    result.summary = "Skipped: no EIN"
    return result
  }

  // ─── 2. FETCH PRIMARY CONTACT ───
  const { data: contactLinks } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id")
    .eq("account_id", p.account_id)
    .limit(1)

  if (!contactLinks?.length) {
    result.steps.push(step("fetch_contact", "error", "No contacts linked"))
    result.summary = "Failed: no contacts"
    result.ok = false
    return result
  }

  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, first_name, last_name, email, phone, citizenship, language")
    .eq("id", contactLinks[0].contact_id)
    .single()

  if (!contact) {
    result.steps.push(step("fetch_contact", "error", "Contact not found"))
    result.summary = "Failed: contact not found"
    result.ok = false
    return result
  }

  result.steps.push(step("fetch_data", "ok", `${account.company_name} / ${contact.full_name}`))
  await updateJobProgress(job.id, result)

  // ─── 2.5. AUTO-CREATE PORTAL ACCOUNTS FOR ALL LINKED MEMBERS ───
  // Runs here (post-EIN / state-confirmed) so members get access only after the LLC is real.
  // Idempotent: autoCreatePortalUser skips existing users and just updates tier.
  try {
    const { autoCreatePortalUser } = await import("@/lib/portal/auto-create")

    const { data: allLinks } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", p.account_id)

    let portalCreated = 0
    let portalExisting = 0
    let portalErrors = 0

    for (const link of allLinks ?? []) {
      try {
        const pr = await autoCreatePortalUser({
          accountId: p.account_id,
          contactId: link.contact_id,
          tier: "active",
          autoCreated: true,
        })
        if (pr.success) {
          if (pr.alreadyExists) portalExisting++
          else portalCreated++
        } else {
          portalErrors++
          console.warn("[welcome-package] portal user failed:", pr.error)
        }
      } catch (memberErr) {
        portalErrors++
        console.warn("[welcome-package] portal user error:", memberErr instanceof Error ? memberErr.message : memberErr)
      }
    }

    result.steps.push(step(
      "portal_members",
      portalErrors > 0 ? "error" : "ok",
      `${portalCreated} created, ${portalExisting} existing, ${portalErrors} errors`
    ))
  } catch (e) {
    result.steps.push(step("portal_members", "error", e instanceof Error ? e.message : String(e)))
  }

  await updateJobProgress(job.id, result)

  const lang = contact.language === "Italian" || contact.language === "it" ? "it" : "en"
  const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

  // ─── 3. OPERATING AGREEMENT ───
  const { data: existingOa } = await supabaseAdmin
    .from("oa_agreements")
    .select("id, token, access_code, status")
    .eq("account_id", p.account_id)
    .limit(1)

  if (existingOa?.length) {
    result.steps.push(step("oa", "skipped", `Already exists: ${existingOa[0].token} (${existingOa[0].status})`))
  } else {
    const STATE_MAP: Record<string, string> = {
      "NEW MEXICO": "NM", "NM": "NM",
      "WYOMING": "WY", "WY": "WY",
      "FLORIDA": "FL", "FL": "FL",
      "DELAWARE": "DE", "DE": "DE",
    }
    const rawState = (account.state_of_formation || "").toUpperCase().trim()
    const state = STATE_MAP[rawState] || rawState
    if (!OA_SUPPORTED_STATES.includes(state as typeof OA_SUPPORTED_STATES[number])) {
      result.steps.push(step("oa", "skipped", `State "${account.state_of_formation}" not supported`))
    } else {
      // Use entity_type from accounts table (set at account creation from contract)
      const entityType = ((account.entity_type as string | null) || "").toLowerCase().includes("multi") ? "MMLLC" : "SMLLC"
      const isMMLC = entityType === "MMLLC"

      let membersJson: Record<string, unknown>[] | null = null
      if (isMMLC) {
        // Read from members table: individual rows use full_name, company rows use company_name.
        // For company members, the signer is the representative — use representative_email.
        const { data: membersRows } = await supabaseAdmin
          .from("members")
          .select("member_type, full_name, company_name, email, representative_email, ownership_pct")
          .eq("account_id", p.account_id)
          .order("is_primary", { ascending: false })

        if (membersRows && membersRows.length > 1) {
          membersJson = membersRows.map(mr => ({
            name: mr.member_type === "company" ? mr.company_name : mr.full_name,
            email: mr.member_type === "company" ? (mr.representative_email || null) : (mr.email || null),
            ownership_pct: mr.ownership_pct ?? null,
            initial_contribution: "$0 (No initial capital contribution required)",
          }))
        }
      }

      const oaToken = `${companySlug}-oa-${year}`
      const { data: oa, error: oaErr } = await supabaseAdmin
        .from("oa_agreements")
        .insert({
          token: oaToken,
          account_id: p.account_id,
          contact_id: contact.id,
          company_name: account.company_name,
          state_of_formation: state,
          formation_date: account.formation_date || today,
          ein_number: account.ein_number,
          entity_type: entityType,
          manager_name: contact.full_name,
          member_name: contact.full_name,
          member_address: account.physical_address || null,
          member_email: contact.email || null,
          members: membersJson as unknown as Json,
          total_signers: isMMLC && membersJson ? membersJson.length : 1,
          signed_count: 0,
          effective_date: account.formation_date || today,
          business_purpose: "any and all lawful business activities",
          initial_contribution: "$0 (No initial capital contribution required)",
          fiscal_year_end: "December 31",
          accounting_method: "Cash",
          duration: "Perpetual",
          registered_agent_name: account.registered_agent_provider || null,
          registered_agent_address: account.registered_agent_address || null,
          principal_address: account.physical_address || "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
          language: "en",
          status: "draft",
        })
        .select("id, token")
        .single()

      if (oaErr || !oa) {
        result.steps.push(step("oa", "error", oaErr?.message || "insert failed"))
      } else {
        result.steps.push(step("oa", "ok", `${oa.token} (${entityType})`))

        // ─── CREATE OA_SIGNATURES FOR MMLLC ───
        // Mirror the oa_create MCP tool's signature scaffolding so multi-member
        // MMLLCs auto-formed via welcome-package can be tracked the same way.
        if (isMMLC && membersJson && membersJson.length > 0) {
          const { data: allContacts } = await supabaseAdmin
            .from("account_contacts")
            .select("contact_id, contacts(id, full_name, email)")
            .eq("account_id", p.account_id)

          const contactsByEmail = new Map<string, string>()
          const contactsByName = new Map<string, string>()
          for (const link of allContacts || []) {
            const c = link.contacts as unknown as { id: string; full_name: string; email: string } | null
            if (c?.email) contactsByEmail.set(c.email.toLowerCase(), c.id)
            if (c?.full_name) contactsByName.set(c.full_name.toLowerCase(), c.id)
          }

          const sigRows = membersJson.map((m, idx) => {
            const memberEmail = (m.email as string | null) || null
            const memberName = (m.name as string) || ""
            const matchedContactId =
              (memberEmail && contactsByEmail.get(memberEmail.toLowerCase())) ||
              contactsByName.get(memberName.toLowerCase()) ||
              null
            return {
              oa_id: oa.id,
              member_index: idx,
              member_name: memberName,
              member_email: memberEmail,
              contact_id: matchedContactId,
              status: "pending",
            }
          })

          const { error: sigErr } = await supabaseAdmin.from("oa_signatures").insert(sigRows)
          if (sigErr) {
            result.steps.push(step("oa_signatures", "error", sigErr.message))
          } else {
            result.steps.push(step("oa_signatures", "ok", `${sigRows.length} signature rows created`))
          }
        }
      }
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 4. LEASE AGREEMENT ───
  {
    const { createLease } = await import("@/lib/operations/lease")
    const leaseResult = await createLease({
      account_id: p.account_id,
      contact_id: contact.id,
      suite_number: p.suite_number,
      effective_date: today,
      term_start_date: today,
      language: lang as "en" | "it",
      actor: "system:welcome-package-setup",
      summary: `Auto-created lease during welcome package setup for ${account.company_name}`,
    })

    if (leaseResult.outcome === "duplicate" && leaseResult.existing) {
      result.steps.push(step("lease", "skipped", `Already exists: ${leaseResult.existing.token}`))
    } else if (leaseResult.success && leaseResult.lease) {
      result.steps.push(step("lease", "ok", `${leaseResult.lease.token} (suite ${leaseResult.lease.suite_number})`))
    } else {
      result.steps.push(step("lease", "error", leaseResult.error || "insert failed"))
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 5. RELAY BANKING FORM ───
  const relayToken = `relay-${companySlug.slice(0, 30)}-${year}`
  const { data: existingRelay } = await supabaseAdmin
    .from("banking_submissions")
    .select("id, token, status")
    .eq("token", relayToken)
    .maybeSingle()

  if (existingRelay) {
    result.steps.push(step("relay", "skipped", `Already exists: ${existingRelay.token}`))
  } else {
    const { data: relay, error: relayErr } = await supabaseAdmin
      .from("banking_submissions")
      .insert({
        token: relayToken,
        account_id: p.account_id,
        contact_id: contact.id,
        provider: "relay",
        language: lang,
        prefilled_data: {
          business_name: account.company_name || "",
          phone: contact.phone || "",
          email: contact.email || "",
          ein: account.ein_number || "",
          first_name: contact.first_name || "",
          last_name: contact.last_name || "",
        },
        status: "pending",
      })
      .select("id, token")
      .single()

    if (relayErr || !relay) {
      result.steps.push(step("relay", "error", relayErr?.message || "insert failed"))
    } else {
      result.steps.push(step("relay", "ok", relay.token))
    }
  }

  // ─── 6. PAYSET BANKING FORM ───
  const paysetToken = `bank-${companySlug.slice(0, 30)}-${year}`
  const { data: existingPayset } = await supabaseAdmin
    .from("banking_submissions")
    .select("id, token, status")
    .eq("token", paysetToken)
    .maybeSingle()

  if (existingPayset) {
    result.steps.push(step("payset", "skipped", `Already exists: ${existingPayset.token}`))
  } else {
    const { data: payset, error: paysetErr } = await supabaseAdmin
      .from("banking_submissions")
      .insert({
        token: paysetToken,
        account_id: p.account_id,
        contact_id: contact.id,
        provider: "payset",
        language: lang,
        prefilled_data: {
          first_name: contact.first_name || "",
          last_name: contact.last_name || "",
          personal_country: contact.citizenship || "",
          business_name: account.company_name || "",
          phone: contact.phone || "",
          email: contact.email || "",
        },
        status: "pending",
      })
      .select("id, token")
      .single()

    if (paysetErr || !payset) {
      result.steps.push(step("payset", "error", paysetErr?.message || "insert failed"))
    } else {
      result.steps.push(step("payset", "ok", payset.token))
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 7. FIND DRIVE DOCUMENTS (EIN + Articles) ───
  if (account.drive_folder_id) {
    try {
      const { listFolder } = await import("@/lib/google-drive")
      const folderResult = await listFolder(account.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
      const folderContents = folderResult.files || []
      const companyFolder = folderContents.find(f =>
        f.name === "Company" && f.mimeType === "application/vnd.google-apps.folder"
      )

      const searchFolderId = companyFolder?.id || account.drive_folder_id
      const filesResult = await listFolder(searchFolderId) as { files?: { id: string; name: string }[] }
      const files = filesResult.files || []

      let einFound = false
      let articlesFound = false
      for (const f of files) {
        const name = (f.name || "").toLowerCase()
        if (name.includes("ein") && !einFound) { einFound = true; result.steps.push(step("ein_letter", "ok", `Found: ${f.id}`)) }
        if (name.includes("articles") && !articlesFound) { articlesFound = true; result.steps.push(step("articles", "ok", `Found: ${f.id}`)) }
      }
      if (!einFound) result.steps.push(step("ein_letter", "skipped", "Not found on Drive"))
      if (!articlesFound) result.steps.push(step("articles", "skipped", "Not found on Drive"))
    } catch {
      result.steps.push(step("drive_search", "skipped", "Drive search failed (non-fatal)"))
    }
  } else {
    result.steps.push(step("drive_search", "skipped", "No drive_folder_id on account"))
  }

  // ─── 8. UPDATE ACCOUNT STATUS ───
  const hasErrors = result.steps.some(s => s.status === "error")
  const wpStatus = hasErrors ? "prepared_with_errors" : "prepared"
  // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
  await supabaseAdmin
    .from("accounts")
    .update({ welcome_package_status: wpStatus })
    .eq("id", p.account_id)

  result.steps.push(step("status_update", "ok", `welcome_package_status → ${wpStatus}`))

  // ─── 9. NOTIFY CLIENT via portal message + push ───
  // Bug 3 fix (master 9e27e14f): branch on payload.context.
  //   - 'onboarding' (existing-account re-onboarding via wizard submit): the
  //     EIN was already on file long before this purchase. The required
  //     wizard uploads (passport, Articles of Organization, EIN, SS-4) are
  //     themselves proof the company exists. Use an onboarding-completion
  //     message; do NOT celebrate the EIN.
  //   - 'formation' or undefined (fresh formation EIN arrival, the original
  //     Stage 3.11 path triggered by record-ein-received / SD advancement):
  //     keep the celebration message.
  try {
    const isIt = lang === "it"
    const isOnboarding = p.context === "onboarding"

    const greeting = isOnboarding
      ? (isIt
          ? `Il tuo onboarding è in elaborazione, ${account.company_name}.`
          : `Your onboarding is being processed, ${account.company_name}.`)
      : (isIt
          ? `Ottima notizia! Il codice fiscale americano (EIN) per ${account.company_name} è stato emesso: ${account.ein_number}.`
          : `Great news! The EIN for ${account.company_name} has been issued: ${account.ein_number}.`)
    const body = isOnboarding
      ? (isIt
          ? `I tuoi moduli bancari (Relay e Payset), il tuo Accordo Operativo e il contratto di domiciliazione sono pronti per essere firmati nel portale.`
          : `Your banking forms (Relay and Payset), your Operating Agreement and your lease are ready to sign in the portal.`)
      : (isIt
          ? `Puoi ora avviare la procedura per aprire il conto bancario aziendale. Accedi al portale per iniziare il processo di apertura del conto e, se applicabile, per firmare il tuo Accordo Operativo e il contratto di domiciliazione.`
          : `You can now start the process to open your business bank account. Log in to your portal to begin the banking wizard and, where applicable, sign your Operating Agreement and lease.`)
    const message = `${greeting}\n\n${body}`

    await supabaseAdmin.from("portal_messages").insert({
      account_id: p.account_id,
      contact_id: contact.id,
      sender_type: "admin",
      sender_id: "b0da5d9c-acf6-4761-9cae-2c3b14dbc631",
      message,
    })

    const { createPortalNotification } = await import("@/lib/portal/notifications")
    await createPortalNotification({
      account_id: p.account_id,
      contact_id: contact.id,
      type: isOnboarding ? "service" : "ein_received",
      title: isOnboarding
        ? (isIt ? "Onboarding in elaborazione" : "Onboarding in progress")
        : (isIt ? "EIN emesso — banking disponibile" : "EIN issued — banking available"),
      body: isOnboarding
        ? (isIt ? "Moduli bancari, OA e lease pronti da firmare." : "Banking forms, OA and lease ready to sign.")
        : (isIt ? `EIN: ${account.ein_number}` : `EIN: ${account.ein_number}`),
      link: isOnboarding ? "/portal" : "/portal/banking",
    })

    result.steps.push(step("notify_client", "ok", `Portal message sent to ${contact.email}${isOnboarding ? " (onboarding context)" : " (formation context)"}`))
  } catch (e) {
    result.steps.push(step("notify_client", "error", e instanceof Error ? e.message : String(e)))
  }

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `Welcome package: ${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
