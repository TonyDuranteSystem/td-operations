/**
 * Job Handler: tax_form_setup
 *
 * Executes the apply_changes phase of tax_form_review:
 * - Contact update (if changed fields map to contact)
 * - Account update (if changed fields map to account)
 * - Tax return → Data Received
 * - Form → reviewed
 *
 * The MCP tool validates and shows diff inline before enqueuing this job.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Job, JobResult } from "../queue"
import { updateJobProgress } from "../queue"

interface TaxFormPayload {
  token: string
  submission_id: string
  contact_id: string | null
  account_id: string | null
  tax_return_id: string | null
  changed_fields: Record<string, { old: unknown; new: unknown }> | null
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

const contactFieldMap: Record<string, string> = {
  owner_first_name: "first_name",
  owner_last_name: "last_name",
  owner_email: "email",
  owner_phone: "phone",
  owner_country: "residency",
  owner_tax_residency: "citizenship",
}

const accountFieldMap: Record<string, string> = {
  llc_name: "company_name",
  ein_number: "ein_number",
  state_of_incorporation: "state_of_formation",
}

export async function handleTaxFormSetup(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as TaxFormPayload
  const result: JobResult = { steps: [] }
  const now = new Date().toISOString()
  const today = now.slice(0, 10)
  const changes = p.changed_fields || {}
  const changeCount = Object.keys(changes).length

  // ─── 1. UPDATE CONTACT WITH CHANGED FIELDS ───
  if (p.contact_id && changeCount > 0) {
    try {
      const contactUpdates: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(changes)) {
        if (contactFieldMap[key]) contactUpdates[contactFieldMap[key]] = val.new
      }

      if (Object.keys(contactUpdates).length > 0) {
        const { error: upErr } = await supabaseAdmin
          .from("contacts")
          .update({ ...contactUpdates, updated_at: now })
          .eq("id", p.contact_id)

        if (upErr) {
          result.steps.push(step("contact_update", "error", upErr.message))
        } else {
          result.steps.push(step("contact_update", "ok", `Updated: ${Object.keys(contactUpdates).join(", ")}`))
        }
      } else {
        result.steps.push(step("contact_update", "skipped", "No contact fields changed"))
      }
    } catch (e) {
      result.steps.push(step("contact_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("contact_update", "skipped", changeCount === 0 ? "No changes" : "No contact_id"))
  }

  await updateJobProgress(job.id, result)

  // ─── 2. UPDATE ACCOUNT WITH CHANGED FIELDS ───
  if (p.account_id && changeCount > 0) {
    try {
      const accountUpdates: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(changes)) {
        if (accountFieldMap[key]) accountUpdates[accountFieldMap[key]] = val.new
      }

      if (Object.keys(accountUpdates).length > 0) {
        const { error: upErr } = await supabaseAdmin
          .from("accounts")
          .update({ ...accountUpdates, updated_at: now })
          .eq("id", p.account_id)

        if (upErr) {
          result.steps.push(step("account_update", "error", upErr.message))
        } else {
          result.steps.push(step("account_update", "ok", `Updated: ${Object.keys(accountUpdates).join(", ")}`))
        }
      } else {
        result.steps.push(step("account_update", "skipped", "No account fields changed"))
      }
    } catch (e) {
      result.steps.push(step("account_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("account_update", "skipped", changeCount === 0 ? "No changes" : "No account_id"))
  }

  await updateJobProgress(job.id, result)

  // ─── 3. UPDATE TAX RETURN → DATA RECEIVED ───
  if (p.tax_return_id) {
    try {
      const { error: trErr } = await supabaseAdmin
        .from("tax_returns")
        .update({
          data_received: true,
          data_received_date: today,
          status: "Data Received",
          updated_at: now,
        })
        .eq("id", p.tax_return_id)

      if (trErr) {
        result.steps.push(step("tax_return_update", "error", trErr.message))
      } else {
        result.steps.push(step("tax_return_update", "ok", "Tax return → Data Received"))
      }
    } catch (e) {
      result.steps.push(step("tax_return_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("tax_return_update", "skipped", "No tax_return_id"))
  }

  // ─── 4. MARK FORM AS REVIEWED ───
  try {
    const { error: formErr } = await supabaseAdmin
      .from("tax_return_submissions")
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

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
