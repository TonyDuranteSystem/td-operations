/**
 * Job Handler: formation_setup
 *
 * Executes the apply_changes phase of formation_form_review:
 * - Contact update with submitted data
 * - Lead → Converted
 * - Form → reviewed
 * - Email notification to support@ (client completed form)
 * - CRM task for Luca (WhatsApp follow-up)
 *
 * The MCP tool validates and shows diff inline before enqueuing this job.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Job, JobResult } from "../queue"
import { updateJobProgress } from "../queue"

interface FormationPayload {
  token: string
  submission_id: string
  contact_id: string | null
  lead_id: string | null
  submitted_data: Record<string, unknown>
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

  // ─── 2. MARK LEAD AS CONVERTED ───
  if (p.lead_id) {
    try {
      const { error: leadErr } = await supabaseAdmin
        .from("leads")
        .update({ status: "Converted", updated_at: now })
        .eq("id", p.lead_id)

      if (leadErr) {
        result.steps.push(step("lead_converted", "error", leadErr.message))
      } else {
        result.steps.push(step("lead_converted", "ok", "Lead → Converted"))
      }
    } catch (e) {
      result.steps.push(step("lead_converted", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("lead_converted", "skipped", "No lead_id"))
  }

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
      `Admin Preview: https://td-operations.vercel.app/formation-form/${p.token}?preview=td`,
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
