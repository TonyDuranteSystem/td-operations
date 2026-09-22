/**
 * Onboarding Form Tools — Create, retrieve, and review onboarding data collection forms.
 * For clients with EXISTING LLCs who are onboarding for management services.
 * Follows the same pattern as formation form tools (formation.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import type { Json } from "@/lib/database.types"

export function registerOnboardingTools(server: McpServer) {

  // ═══════════════════════════════════════
  // onboarding_form_create
  // ═══════════════════════════════════════
  server.tool(
    "onboarding_form_create",
    `Create an onboarding data collection form for a client with an existing LLC. Pre-fills owner info from lead. Entity type (SMLLC/MMLLC) and state set as metadata. Returns the form URL (${APP_BASE_URL}/onboarding-form/{token}/{access_code}). Admin preview: append ?preview=td to the form URL to bypass the email gate. ALWAYS provide the admin preview link after creating a form so Antonio can review it before sending. Use gmail_send to send the link. Unlike formation_form_create, this is for clients who already have an LLC and need management services.`,
    {
      lead_id: z.string().uuid().describe("Lead UUID"),
      entity_type: z.enum(["SMLLC", "MMLLC"]).optional().default("SMLLC").describe("Entity type (default: SMLLC)"),
      state: z.string().optional().default("NM").describe("State of formation (default: NM)"),
      language: z.enum(["en", "it"]).optional().describe("Form language (auto-detected from lead.language if omitted)"),
      account_id: z.string().uuid().optional().describe("Existing CRM account UUID if already created"),
    },
    async ({ lead_id, entity_type, state, language, account_id }) => {
      try {
        // 1. Get lead data
        const { data: lead, error: leadErr } = await supabaseAdmin
          .from("leads")
          .select("id, full_name, email, phone, language, status")
          .eq("id", lead_id)
          .single()
        if (leadErr || !lead) throw new Error(`Lead not found: ${leadErr?.message || lead_id}`)

        // 2. Check if contact already exists
        let contactId: string | null = null
        if (lead.email) {
          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("id")
            .eq("email", lead.email)
            .maybeSingle()
          contactId = contact?.id || null
        }

        // 3. Build prefilled data from lead
        const nameParts = (lead.full_name || "").trim().split(/\s+/)
        const firstName = nameParts[0] || ""
        const lastName = nameParts.slice(1).join(" ") || ""

        const prefilled: Record<string, unknown> = {
          owner_first_name: firstName,
          owner_last_name: lastName,
          owner_email: lead.email || "",
          owner_phone: lead.phone || "",
        }

        // 4. If account exists, prefill company info
        if (account_id) {
          const { data: acct } = await supabaseAdmin
            .from("accounts")
            .select("company_name, state_of_formation, formation_date, ein_number, entity_type")
            .eq("id", account_id)
            .single()
          if (acct) {
            if (acct.company_name) prefilled.company_name = acct.company_name
            if (acct.state_of_formation) prefilled.state_of_formation = acct.state_of_formation
            if (acct.formation_date) prefilled.formation_date = acct.formation_date
            if (acct.ein_number) prefilled.ein = acct.ein_number
          }
        }

        // 5. If contact exists, prefill ITIN
        if (contactId) {
          const { data: ct } = await supabaseAdmin
            .from("contacts")
            .select("itin_number, itin_issue_date, citizenship, date_of_birth")
            .eq("id", contactId)
            .single()
          if (ct) {
            if (ct.itin_number) prefilled.owner_itin = ct.itin_number
            if (ct.itin_issue_date) prefilled.owner_itin_issue_date = ct.itin_issue_date
            if (ct.citizenship) prefilled.owner_nationality = ct.citizenship
            if (ct.date_of_birth) prefilled.owner_dob = ct.date_of_birth
          }
        }

        // 6. Generate token
        const slug = (lead.full_name || "form")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 30)
        const year = new Date().getFullYear()
        const token = `onb-${slug}-${year}`

        // 7. Check for existing submission
        const { data: existing } = await supabaseAdmin
          .from("onboarding_submissions")
          .select("id, token, status, access_code")
          .eq("token", token)
          .maybeSingle()
        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Onboarding form already exists for ${lead.full_name}\nToken: ${existing.token}\nStatus: ${existing.status}\nURL: ${APP_BASE_URL}/onboarding-form/${existing.token}/${existing.access_code}`,
            }],
          }
        }

        // 8. Determine language
        const formLang = language || (lead.language === "Italian" || lead.language === "it" ? "it" : "en")

        // 9. Insert
        const { data: submission, error: insErr } = await supabaseAdmin
          .from("onboarding_submissions")
          .insert({
            token,
            lead_id,
            contact_id: contactId,
            account_id: account_id || null,
            entity_type: entity_type || "SMLLC",
            state: state || "NM",
            language: formLang,
            prefilled_data: prefilled as unknown as Json,
            status: "pending",
          })
          .select("id, token, access_code")
          .single()
        if (insErr) throw new Error(insErr.message)

        const url = `${APP_BASE_URL}/onboarding-form/${token}/${submission.access_code}`
        const adminPreviewUrl = `${url}?preview=td`
        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Onboarding form created for ${lead.full_name}`,
              `   Entity: ${entity_type || "SMLLC"} | State: ${state || "NM"} | Lang: ${formLang}`,
              `   Lead: ${lead.full_name} (${lead.email})`,
              `   Token: ${token}`,
              `   ID: ${submission.id}`,
              "",
              `   👁️ Admin Preview: ${adminPreviewUrl}`,
              `   🔗 Client URL: ${url}`,
              "",
              `⚠️ Review the admin preview FIRST, then send the client URL via gmail_send`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // onboarding_form_get
  // ═══════════════════════════════════════
  server.tool(
    "onboarding_form_get",
    "Get an onboarding data collection form by token or lead_id. Returns prefilled data, submitted data, status, timestamps, and changed fields.",
    {
      token: z.string().optional().describe("Form token (e.g., 'onb-mario-rossi-2026')"),
      lead_id: z.string().uuid().optional().describe("Lead UUID"),
    },
    async ({ token, lead_id }) => {
      try {
        let q = supabaseAdmin.from("onboarding_submissions").select("*")
        if (token) {
          q = q.eq("token", token)
        } else if (lead_id) {
          q = q.eq("lead_id", lead_id)
        } else {
          return { content: [{ type: "text" as const, text: "Provide either token OR lead_id." }] }
        }

        const { data, error } = await q.maybeSingle()
        if (error) throw new Error(error.message)
        if (!data) return { content: [{ type: "text" as const, text: "No form found." }] }

        let leadName = ""
        if (data.lead_id) {
          const { data: lead } = await supabaseAdmin
            .from("leads")
            .select("full_name")
            .eq("id", data.lead_id)
            .single()
          leadName = lead?.full_name || ""
        }

        const changedCount = data.changed_fields ? Object.keys(data.changed_fields as object).length : 0

        const lines = [
          `📋 Onboarding Form: ${data.token}`,
          `   Lead: ${leadName}`,
          `   Entity: ${data.entity_type} | State: ${data.state} | Lang: ${data.language}`,
          `   Status: ${data.status}`,
          "",
          `   Created: ${data.created_at}`,
          data.sent_at ? `   Sent: ${data.sent_at}` : null,
          data.opened_at ? `   Opened: ${data.opened_at}` : null,
          data.completed_at ? `   Completed: ${data.completed_at}` : null,
          data.reviewed_at ? `   Reviewed: ${data.reviewed_at} by ${data.reviewed_by}` : null,
          "",
          `   Changed fields: ${changedCount}`,
        ].filter(Boolean)

        if (changedCount > 0) {
          lines.push("")
          lines.push("   🔄 Changes detected:")
          for (const [key, val] of Object.entries(data.changed_fields as Record<string, { old: unknown; new: unknown }>)) {
            lines.push(`      ${key}: "${val.old}" → "${val.new}"`)
          }
        }

        if (data.upload_paths && (data.upload_paths as string[]).length > 0) {
          lines.push("")
          lines.push(`   📎 Uploads: ${(data.upload_paths as string[]).length} files`)
        }

        const formUrl = `${APP_BASE_URL}/onboarding-form/${data.token}/${data.access_code}`
        const adminPreviewUrl = `${formUrl}?preview=td`

        lines.push("")
        lines.push(`   👁️ Admin Preview: ${adminPreviewUrl}`)
        lines.push(`   🔗 Client URL: ${formUrl}`)
        lines.push(`   ID: ${data.id}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // onboarding_form_review
  // ═══════════════════════════════════════
  server.tool(
    "onboarding_form_review",
    "Review a completed onboarding form submission. Shows submitted data + diff of changed fields. If apply_changes=true, performs FULL post-onboarding CRM setup: creates/updates Contact and Account, links them, creates Drive folder (Companies/{State}/{Company}/), copies uploaded documents from Supabase Storage to Drive, sets drive_folder_id on account, creates follow-up tasks (WhatsApp group, lease agreement, RA change), checks tax return status and creates tax_returns records if needed, sets portal fields, marks lead as Converted, and marks form as reviewed. Always run without apply_changes first to review.",
    {
      token: z.string().describe("Form token to review"),
      apply_changes: z.boolean().optional().default(false).describe("If true, apply changes to CRM"),
    },
    async ({ token, apply_changes }) => {
      try {
        const { data: sub, error } = await supabaseAdmin
          .from("onboarding_submissions")
          .select("*")
          .eq("token", token)
          .single()
        if (error || !sub) throw new Error(`Form not found: ${token}`)

        if (sub.status !== "completed") {
          return { content: [{ type: "text" as const, text: `⚠️ Form status is "${sub.status}" — not yet completed by client.` }] }
        }

        const changes = sub.changed_fields as Record<string, { old: unknown; new: unknown }> | null
        const changeCount = changes ? Object.keys(changes).length : 0
        const submitted = sub.submitted_data as Record<string, unknown> || {}

        let leadName = token
        if (sub.lead_id) {
          const { data: lead } = await supabaseAdmin
            .from("leads")
            .select("full_name")
            .eq("id", sub.lead_id)
            .single()
          leadName = lead?.full_name || token
        }

        const lines = [
          `═══════════════════════════════════════`,
          `  ONBOARDING FORM REVIEW: ${leadName}`,
          `  ${sub.entity_type} | ${sub.state} | ${sub.language}`,
          `═══════════════════════════════════════`,
          "",
        ]

        // Show submitted data summary
        lines.push("OWNER:")
        lines.push(`   Name: ${submitted.owner_first_name || ""} ${submitted.owner_last_name || ""}`)
        lines.push(`   Email: ${submitted.owner_email || ""}`)
        lines.push(`   Phone: ${submitted.owner_phone || ""}`)
        lines.push(`   DOB: ${submitted.owner_dob || ""}`)
        lines.push(`   Nationality: ${submitted.owner_nationality || ""}`)
        lines.push(`   Address: ${submitted.owner_street || ""}, ${submitted.owner_city || ""} ${submitted.owner_zip || ""}, ${submitted.owner_country || ""}`)
        if (submitted.owner_itin) lines.push(`   ITIN: ${submitted.owner_itin}`)
        if (submitted.owner_itin_issue_date) lines.push(`   ITIN Issue Date: ${submitted.owner_itin_issue_date}`)

        lines.push("")
        lines.push("COMPANY:")
        lines.push(`   Name: ${submitted.company_name || ""}`)
        lines.push(`   State: ${submitted.state_of_formation || ""}`)
        lines.push(`   Formed: ${submitted.formation_date || ""}`)
        lines.push(`   EIN: ${submitted.ein || "(not provided)"}`)
        if (submitted.filing_id) lines.push(`   Filing ID: ${submitted.filing_id}`)
        lines.push(`   Purpose: ${submitted.business_purpose || ""}`)
        if (submitted.registered_agent) lines.push(`   Current RA: ${submitted.registered_agent}`)

        // Show members if MMLLC
        const members = submitted.additional_members as Record<string, string>[] | undefined
        if (members && members.length > 0) {
          lines.push("")
          lines.push(`ADDITIONAL MEMBERS (${members.length}):`)
          for (const m of members) {
            lines.push(`   - ${m.member_first_name || ""} ${m.member_last_name || ""} — ${m.member_ownership_pct || "?"}% (${m.member_email || ""})`)
          }
        }

        // Tax return status from submitted data
        lines.push("")
        lines.push("TAX STATUS:")
        lines.push(`   Previous year filed: ${submitted.tax_return_previous_year_filed || "(not answered)"}`)
        lines.push(`   Current year filed: ${submitted.tax_return_current_year_filed || "(not answered)"}`)

        lines.push("")

        if (changeCount === 0) {
          lines.push("No changes detected — all pre-filled data was confirmed.")
        } else {
          lines.push(`${changeCount} field(s) changed from pre-filled:`)
          lines.push("")
          lines.push("| Field | Pre-filled | Client Value |")
          lines.push("|-------|-----------|-------------|")
          for (const [key, val] of Object.entries(changes!)) {
            const oldVal = val.old === null || val.old === "" ? "(empty)" : String(val.old)
            const newVal = String(val.new)
            lines.push(`| ${key} | ${oldVal} | ${newVal} |`)
          }
        }

        const uploads = sub.upload_paths as string[] | null
        if (uploads && uploads.length > 0) {
          lines.push("")
          lines.push(`${uploads.length} file(s) uploaded:`)
          for (const path of uploads) {
            lines.push(`   - ${path}`)
          }
        }

        lines.push("")
        lines.push(`Submitted: ${sub.completed_at}`)

        if (apply_changes) {
          lines.push("")
          lines.push("───────────────────────────────────")
          lines.push("APPLYING CHANGES — CRM SETUP + ASYNC JOB")
          lines.push("───────────────────────────────────")
          lines.push("")

          // Extracted (2026-09-20, dev job bc2a8f7f) to lib/operations/onboarding-review.ts
          // so the dashboard "Confirm" button (app/api/onboarding-review/[id]/confirm)
          // can call the exact same logic instead of duplicating it. Includes the
          // reviewed_at idempotency lock (double-tap/double-click protection).
          const { applyOnboardingReview } = await import("@/lib/operations/onboarding-review")
          const result = await applyOnboardingReview(sub.id, "claude")
          if (!result.ok) {
            return { content: [{ type: "text" as const, text: `Error applying review: ${result.error}` }] }
          }
          lines.push(...result.lines)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

} // end registerOnboardingTools
