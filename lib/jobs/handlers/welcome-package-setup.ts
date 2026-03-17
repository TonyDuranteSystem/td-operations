/**
 * Job Handler: welcome_package_prepare
 *
 * Auto-triggered when Company Formation SD advances to "Post-Formation + Banking".
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
import type { Job, JobResult } from "../queue"
import { updateJobProgress } from "../queue"
import { APP_BASE_URL } from "@/lib/config"

interface WelcomePackagePayload {
  account_id: string
  suite_number?: string
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

const BASE_URL = APP_BASE_URL

export async function handleWelcomePackagePrepare(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as WelcomePackagePayload
  const result: JobResult = { steps: [] }
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date().toISOString()
  const year = new Date().getFullYear()

  // ─── 1. FETCH ACCOUNT ───
  const { data: account, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, ein_number, state_of_formation, formation_date, physical_address, registered_agent_address, registered_agent_provider, drive_folder_id, welcome_package_status")
    .eq("id", p.account_id)
    .single()

  if (accErr || !account) {
    result.steps.push(step("fetch_account", "error", accErr?.message || "Account not found"))
    result.summary = "Failed: account not found"
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
    return result
  }

  result.steps.push(step("fetch_data", "ok", `${account.company_name} / ${contact.full_name}`))
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
    const state = (account.state_of_formation || "").toUpperCase()
    if (!OA_SUPPORTED_STATES.includes(state as typeof OA_SUPPORTED_STATES[number])) {
      result.steps.push(step("oa", "skipped", `State "${state}" not supported`))
    } else {
      // Check for MMLLC
      const { data: allContacts } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id")
        .eq("account_id", p.account_id)

      const isMMLC = (allContacts?.length || 1) > 1
      const entityType = isMMLC ? "MMLLC" : "SMLLC"

      let membersJson: Record<string, unknown>[] | null = null
      if (isMMLC && allContacts) {
        const { data: memberContacts } = await supabaseAdmin
          .from("contacts")
          .select("full_name, email")
          .in("id", allContacts.map(c => c.contact_id))

        if (memberContacts && memberContacts.length > 1) {
          const pct = Math.floor(100 / memberContacts.length)
          const remainder = 100 - pct * memberContacts.length
          membersJson = memberContacts.map((mc, i) => ({
            name: mc.full_name,
            email: mc.email || null,
            ownership_pct: pct + (i === 0 ? remainder : 0),
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
          members: membersJson,
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
      }
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 4. LEASE AGREEMENT ───
  const { data: existingLease } = await supabaseAdmin
    .from("lease_agreements")
    .select("id, token, status")
    .eq("account_id", p.account_id)
    .limit(1)

  if (existingLease?.length) {
    result.steps.push(step("lease", "skipped", `Already exists: ${existingLease[0].token}`))
  } else {
    let assignedSuite = p.suite_number
    if (!assignedSuite) {
      const { data: leases } = await supabaseAdmin
        .from("lease_agreements")
        .select("suite_number")
        .like("suite_number", "3D-%")
        .order("suite_number", { ascending: false })
        .limit(1)
      if (leases?.length) {
        const lastNum = parseInt(leases[0].suite_number.replace("3D-", ""), 10)
        assignedSuite = `3D-${(lastNum + 1).toString().padStart(3, "0")}`
      } else {
        assignedSuite = "3D-101"
      }
    }

    const leaseToken = `${companySlug}-${year}`
    const { data: lease, error: leaseErr } = await supabaseAdmin
      .from("lease_agreements")
      .insert({
        token: leaseToken,
        account_id: p.account_id,
        contact_id: contact.id,
        tenant_company: account.company_name,
        tenant_name: contact.full_name,
        tenant_email: contact.email,
        suite_number: assignedSuite,
        premises_address: "10225 Ulmerton Rd, Largo, FL 33771",
        effective_date: today,
        term_start_date: today,
        term_end_date: `${year}-12-31`,
        contract_year: year,
        term_months: 12,
        monthly_rent: 100,
        yearly_rent: 1200,
        security_deposit: 150,
        square_feet: 120,
        status: "draft",
        language: lang,
      })
      .select("id, token, suite_number")
      .single()

    if (leaseErr || !lease) {
      result.steps.push(step("lease", "error", leaseErr?.message || "insert failed"))
    } else {
      result.steps.push(step("lease", "ok", `${lease.token} (suite ${lease.suite_number})`))
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
  await supabaseAdmin
    .from("accounts")
    .update({ welcome_package_status: wpStatus })
    .eq("id", p.account_id)

  result.steps.push(step("status_update", "ok", `welcome_package_status → ${wpStatus}`))

  // ─── 9. CREATE TASK: Review & Send Welcome Email ───
  try {
    const { data: existingTask } = await supabaseAdmin
      .from("tasks")
      .select("id")
      .eq("task_title", `Review & send welcome email — ${account.company_name}`)
      .eq("account_id", p.account_id)
      .maybeSingle()

    if (!existingTask) {
      await supabaseAdmin.from("tasks").insert({
        task_title: `Review & send welcome email — ${account.company_name}`,
        description: [
          `Welcome package prepared for ${account.company_name}.`,
          ``,
          `Use welcome_package_prepare(account_id="${p.account_id}") to see all links and the email draft.`,
          `Then use gmail_send to send the email with EIN letter + Articles as attachments.`,
        ].join("\n"),
        assigned_to: "Luca",
        priority: "High",
        category: "Formation",
        status: "To Do",
        account_id: p.account_id,
        created_by: "System",
      })
      result.steps.push(step("review_task", "ok", "Task created: review & send welcome email"))
    } else {
      result.steps.push(step("review_task", "skipped", "Already exists"))
    }
  } catch (e) {
    result.steps.push(step("review_task", "error", e instanceof Error ? e.message : String(e)))
  }

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `Welcome package: ${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
