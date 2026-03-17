/**
 * Job Handler: formation_setup
 *
 * Executes the apply_changes phase of formation_form_review:
 * - Contact update with submitted data
 * - CRM Account creation (LLC placeholder — EIN/formation_date added later)
 * - Service Delivery creation (Company Formation, Stage 1)
 * - Form → reviewed
 * - Email notification to support@ (client completed form)
 * - CRM task for Luca (WhatsApp follow-up)
 *
 * The MCP tool validates and shows diff inline before enqueuing this job.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import type { Job, JobResult } from "../queue"
import { updateJobProgress } from "../queue"

interface FormationPayload {
  token: string
  submission_id: string
  contact_id: string | null
  lead_id: string | null
  submitted_data: Record<string, unknown>
}

// State name → code mapping for formation
const STATE_CODE_MAP: Record<string, string> = {
  "New Mexico": "NM", "NM": "NM",
  "Wyoming": "WY", "WY": "WY",
  "Florida": "FL", "FL": "FL",
  "Delaware": "DE", "DE": "DE",
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleFormationSetup(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as FormationPayload
  const result: JobResult = { steps: [] }
  const now = new Date().toISOString()
  const submitted = p.submitted_data || {}

  // ─── 1. UPDATE CONTACT WITH SUBMITTED DATA ───
  if (p.contact_id) {
    try {
      const contactUpdates: Record<string, unknown> = {
        updated_at: now,
      }

      if (submitted.owner_first_name) contactUpdates.first_name = submitted.owner_first_name
      if (submitted.owner_last_name) contactUpdates.last_name = submitted.owner_last_name
      if (submitted.owner_email) contactUpdates.email = submitted.owner_email
      if (submitted.owner_phone) contactUpdates.phone = submitted.owner_phone
      if (submitted.owner_nationality) contactUpdates.citizenship = submitted.owner_nationality
      if (submitted.owner_country) contactUpdates.residency = submitted.owner_country

      const fieldCount = Object.keys(contactUpdates).filter(k => k !== "updated_at").length
      if (fieldCount > 0) {
        const { error: upErr } = await supabaseAdmin
          .from("contacts")
          .update(contactUpdates)
          .eq("id", p.contact_id)

        if (upErr) {
          result.steps.push(step("contact_update", "error", upErr.message))
        } else {
          result.steps.push(step("contact_update", "ok", `${fieldCount} fields updated`))
        }
      } else {
        result.steps.push(step("contact_update", "skipped", "No contact fields to update"))
      }
    } catch (e) {
      result.steps.push(step("contact_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("contact_update", "skipped", "No contact_id"))
  }

  await updateJobProgress(job.id, result)

  // ─── 2. LEAD CONVERSION — SKIPPED (now happens at payment in whop webhook / check-wire-payments) ───
  result.steps.push(step("lead_converted", "skipped", "Moved to payment confirmation (Change 1.1)"))

  // ─── 2a. CREATE CRM ACCOUNT (LLC placeholder — EIN/formation_date added later) ───
  let accountId: string | null = null
  const companyName = String(submitted.llc_name_1 || "").trim()

  if (companyName && p.contact_id) {
    try {
      // Fetch submission for entity_type and state
      const { data: formSub } = await supabaseAdmin
        .from("formation_submissions")
        .select("entity_type, state")
        .eq("id", p.submission_id)
        .single()

      const entityType = formSub?.entity_type || "SMLLC"
      const stateRaw = formSub?.state || ""
      const stateCode = STATE_CODE_MAP[stateRaw] || stateRaw

      // Check if account already exists for this company name
      const { data: existingAcct } = await supabaseAdmin
        .from("accounts")
        .select("id")
        .ilike("company_name", companyName)
        .limit(1)

      if (existingAcct?.length) {
        accountId = existingAcct[0].id
        result.steps.push(step("account_create", "skipped", `Already exists: ${accountId}`))
      } else {
        const { data: newAcct, error: acctErr } = await supabaseAdmin
          .from("accounts")
          .insert({
            company_name: companyName,
            entity_type: entityType,
            state_of_formation: stateCode,
            account_type: "Formation",
            status: "Pending Formation",
            // EIN, formation_date, registered_agent — filled later when state confirms
          })
          .select("id")
          .single()

        if (acctErr || !newAcct) {
          result.steps.push(step("account_create", "error", acctErr?.message || "insert failed"))
        } else {
          accountId = newAcct.id

          // Link contact to account
          const { error: linkErr } = await supabaseAdmin
            .from("account_contacts")
            .insert({
              account_id: newAcct.id,
              contact_id: p.contact_id,
              role: "Owner",
            })

          if (linkErr && !linkErr.message.includes("duplicate")) {
            result.steps.push(step("account_create", "ok", `${companyName} (${entityType}, ${stateCode}) — link error: ${linkErr.message}`))
          } else {
            result.steps.push(step("account_create", "ok", `${companyName} (${entityType}, ${stateCode}) → linked to contact`))
          }
        }
      }

      // Also link to submission for traceability
      if (accountId) {
        await supabaseAdmin
          .from("formation_submissions")
          .update({ account_id: accountId })
          .eq("id", p.submission_id)
      }
    } catch (e) {
      result.steps.push(step("account_create", "error", e instanceof Error ? e.message : String(e)))
    }
    await updateJobProgress(job.id, result)
  } else {
    result.steps.push(step("account_create", "skipped", companyName ? "No contact_id" : "No LLC name in submitted data"))
  }

  // ─── 2b. CREATE SERVICE DELIVERY (Company Formation pipeline, Stage 1: Data Collection) ───
  try {
    const sdContactId = p.contact_id
    if (sdContactId) {
      // Check if SD already exists for this contact
      const { data: existingSd } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("contact_id", sdContactId)
        .eq("service_type", "Company Formation")
        .eq("status", "active")
        .limit(1)

      if (existingSd && existingSd.length > 0) {
        result.steps.push(step("service_delivery", "skipped", `Already exists: ${existingSd[0].id}`))
      } else {
        const sdName = companyName ? `Company Formation - ${companyName}` : "Company Formation"
        const { data: sd, error: sdErr } = await supabaseAdmin
          .from("service_deliveries")
          .insert({
            service_name: sdName,
            service_type: "Company Formation",
            pipeline: "Company Formation",
            stage: "Data Collection",
            stage_order: 1,
            stage_entered_at: now,
            stage_history: JSON.stringify([{ stage: "Data Collection", entered_at: now, by: "formation_setup" }]),
            contact_id: sdContactId,
            account_id: accountId, // Now linked to CRM account
            status: "active",
            start_date: now.slice(0, 10),
            assigned_to: "Luca",
          })
          .select("id")
          .single()

        if (sdErr) {
          result.steps.push(step("service_delivery", "error", sdErr.message))
        } else {
          result.steps.push(step("service_delivery", "ok", `SD created: ${sd.id} (Data Collection${accountId ? ", linked to account" : ""})`))
        }
      }
    } else {
      result.steps.push(step("service_delivery", "skipped", "No contact_id available"))
    }
  } catch (e) {
    result.steps.push(step("service_delivery", "error", e instanceof Error ? e.message : String(e)))
  }

  await updateJobProgress(job.id, result)

  // ─── 3. MARK FORM AS REVIEWED ───
  try {
    const { error: formErr } = await supabaseAdmin
      .from("formation_submissions")
      .update({
        status: "reviewed",
        reviewed_at: now,
        reviewed_by: "claude",
      })
      .eq("id", p.submission_id)

    if (formErr) {
      result.steps.push(step("form_reviewed", "error", formErr.message))
    } else {
      result.steps.push(step("form_reviewed", "ok", "Form → reviewed"))
    }
  } catch (e) {
    result.steps.push(step("form_reviewed", "error", e instanceof Error ? e.message : String(e)))
  }

  await updateJobProgress(job.id, result)

  // ─── 4. EMAIL NOTIFICATION TO SUPPORT ───
  try {
    const clientName = submitted.owner_first_name
      ? `${submitted.owner_first_name} ${submitted.owner_last_name || ""}`
      : p.token

    const { gmailPost } = await import("@/lib/gmail")

    const subject = `Formation Form Completed: ${clientName}`
    const body = [
      `Client ${clientName} has completed the formation data collection form.`,
      ``,
      `Token: ${p.token}`,
      `Email: ${submitted.owner_email || "N/A"}`,
      `LLC Names: ${submitted.llc_name_1 || "N/A"}`,
      ``,
      `Review: formation_form_review(token="${p.token}")`,
      `Admin Preview: ${APP_BASE_URL}/formation-form/${p.token}?preview=td`,
    ].join("\n")

    const boundary = `boundary_${Date.now()}`
    const mimeHeaders = [
      `From: Tony Durante LLC <support@tonydurante.us>`,
      `To: support@tonydurante.us`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      `Content-Type: text/plain; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
    ]
    const rawEmail = [...mimeHeaders, "", Buffer.from(body).toString("base64")].join("\r\n")
    const encodedRaw = Buffer.from(rawEmail).toString("base64url")

    await gmailPost("/messages/send", { raw: encodedRaw })
    result.steps.push(step("email_notification", "ok", `Notified support@ about ${clientName}`))
  } catch (e) {
    result.steps.push(step("email_notification", "error", e instanceof Error ? e.message : String(e)))
  }

  // ─── 5. CRM TASK FOR LUCA (WHATSAPP FOLLOW-UP) ───
  try {
    const clientName = submitted.owner_first_name
      ? `${submitted.owner_first_name} ${submitted.owner_last_name || ""}`
      : p.token

    const { error: taskErr } = await supabaseAdmin.from("tasks").insert({
      task_title: `WhatsApp follow-up: ${clientName} (formation form completed)`,
      description: [
        `Il cliente ${clientName} ha completato il formation form.`,
        ``,
        `Email: ${submitted.owner_email || "N/A"}`,
        `Phone: ${submitted.owner_phone || "N/A"}`,
        `LLC Name: ${submitted.llc_name_1 || "N/A"}`,
        ``,
        `Azione: Contattare via WhatsApp per confermare ricezione e prossimi step.`,
        `Review form: formation_form_review(token="${p.token}")`,
      ].join("\n"),
      assigned_to: "Luca",
      priority: "High",
      category: "Formation",
      status: "todo",
      ...(accountId ? { account_id: accountId } : {}),
    })

    if (taskErr) {
      result.steps.push(step("luca_whatsapp_task", "error", taskErr.message))
    } else {
      result.steps.push(step("luca_whatsapp_task", "ok", `WhatsApp task created for Luca`))
    }
  } catch (e) {
    result.steps.push(step("luca_whatsapp_task", "error", e instanceof Error ? e.message : String(e)))
  }

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
