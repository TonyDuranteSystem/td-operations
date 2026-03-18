/**
 * Closure Form Tools — Create, retrieve, and review LLC closure/dissolution data collection forms.
 * Follows the same pattern as formation form tools (formation.ts).
 *
 * Company Closure is a one-time service: dissolve an existing LLC.
 * Pipeline: Data Collection → State Compliance Check → State Dissolution Filing → IRS Closure → Closing
 *
 * IMPORTANT: The offer price excludes outstanding state fees/taxes.
 * The State Compliance Check stage verifies Secretary of State records before filing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"

export function registerClosureTools(server: McpServer) {

  // ═══════════════════════════════════════
  // closure_form_create
  // ═══════════════════════════════════════
  server.tool(
    "closure_form_create",
    `Create a closure data collection form for an LLC dissolution client. Pre-fills owner info from the lead or contact record. Returns the form URL (${APP_BASE_URL}/closure-form/{token}).

Admin preview: append ?preview=td to bypass the email gate.
ALWAYS provide the admin preview link so Antonio can review before sending to client.

The form collects: owner contact info, LLC name, EIN, state, formation year, registered agent, tax return history.
NOTE: The closure fee does NOT include any outstanding state taxes/fees. This is stated in the form disclaimer.

Use gmail_send to send the link to the client after Antonio approves.`,
    {
      lead_id: z.string().uuid().optional().describe("Lead UUID (if coming from a lead)"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (if existing client)"),
      account_id: z.string().uuid().optional().describe("Account UUID (the LLC being closed, if known)"),
      language: z.enum(["en", "it"]).optional().describe("Form language (auto-detected if omitted)"),
    },
    async ({ lead_id, contact_id, account_id, language }) => {
      try {
        if (!lead_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Provide either lead_id or contact_id." }] }
        }

        // 1. Get source data
        let fullName = ""
        let email = ""
        let phone = ""
        let lang = language || "it"

        if (lead_id) {
          const { data: lead, error } = await supabaseAdmin
            .from("leads")
            .select("id, full_name, email, phone, language")
            .eq("id", lead_id)
            .single()
          if (error || !lead) throw new Error(`Lead not found: ${error?.message || lead_id}`)
          fullName = lead.full_name || ""
          email = lead.email || ""
          phone = lead.phone || ""
          if (!language) lang = lead.language === "Italian" || lead.language === "it" ? "it" : "en"
        }

        if (contact_id && !fullName) {
          const { data: contact, error } = await supabaseAdmin
            .from("contacts")
            .select("id, first_name, last_name, email, phone")
            .eq("id", contact_id)
            .single()
          if (error || !contact) throw new Error(`Contact not found: ${error?.message || contact_id}`)
          fullName = `${contact.first_name || ""} ${contact.last_name || ""}`.trim()
          email = contact.email || ""
          phone = contact.phone || ""
        }

        // 2. Also try to link contact if we only have lead
        let resolvedContactId = contact_id || null
        if (!resolvedContactId && email) {
          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("id")
            .eq("email", email)
            .maybeSingle()
          resolvedContactId = contact?.id || null
        }

        // 3. If account_id provided, get LLC info for prefill
        let llcName = ""
        let llcEin = ""
        let llcState = ""
        if (account_id) {
          const { data: account } = await supabaseAdmin
            .from("accounts")
            .select("name, ein, state_of_formation")
            .eq("id", account_id)
            .single()
          if (account) {
            llcName = account.name || ""
            llcEin = account.ein || ""
            llcState = account.state_of_formation || ""
          }
        }

        // 4. Build prefilled data
        const nameParts = fullName.trim().split(/\s+/)
        const firstName = nameParts[0] || ""
        const lastName = nameParts.slice(1).join(" ") || ""

        const prefilled: Record<string, unknown> = {
          owner_first_name: firstName,
          owner_last_name: lastName,
          owner_email: email,
          owner_phone: phone,
        }
        if (llcName) prefilled.llc_name = llcName
        if (llcEin) prefilled.llc_ein = llcEin
        if (llcState) prefilled.llc_state = llcState

        // 5. Generate token
        const slug = (fullName || "form")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 30)
        const year = new Date().getFullYear()
        const token = `closure-${slug}-${year}`

        // 6. Check for existing
        const { data: existing } = await supabaseAdmin
          .from("closure_submissions")
          .select("id, token, status, access_code")
          .eq("token", token)
          .maybeSingle()
        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Closure form already exists for ${fullName}\nToken: ${existing.token}\nStatus: ${existing.status}\nURL: ${APP_BASE_URL}/closure-form/${existing.token}/${existing.access_code}\n👁️ Preview: ${APP_BASE_URL}/closure-form/${existing.token}/${existing.access_code}?preview=td`,
            }],
          }
        }

        // 7. Insert
        const { data: submission, error: insErr } = await supabaseAdmin
          .from("closure_submissions")
          .insert({
            token,
            lead_id: lead_id || null,
            contact_id: resolvedContactId,
            account_id: account_id || null,
            language: lang,
            prefilled_data: prefilled,
            status: "pending",
          })
          .select("id, token, access_code")
          .single()
        if (insErr) throw new Error(insErr.message)

        const url = `${APP_BASE_URL}/closure-form/${token}/${submission.access_code}`
        const adminPreviewUrl = `${url}?preview=td`
        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Closure form created for ${fullName}`,
              `   Lang: ${lang}`,
              lead_id ? `   Lead: ${fullName} (${email})` : `   Contact: ${fullName} (${email})`,
              llcName ? `   LLC: ${llcName} (${llcState})` : "",
              `   Token: ${token}`,
              `   ID: ${submission.id}`,
              "",
              `   👁️ Admin Preview: ${adminPreviewUrl}`,
              `   🔗 Client URL: ${url}`,
              "",
              `⚠️ Review the admin preview FIRST, then send the client URL via gmail_send`,
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // closure_form_get
  // ═══════════════════════════════════════
  server.tool(
    "closure_form_get",
    "Get a closure data collection form by token, lead_id, or contact_id. Returns prefilled data, submitted data, status, timestamps, and changed fields. Use this to check form status or review client submissions.",
    {
      token: z.string().optional().describe("Form token (e.g., 'closure-mario-rossi-2026')"),
      lead_id: z.string().uuid().optional().describe("Lead UUID"),
      contact_id: z.string().uuid().optional().describe("Contact UUID"),
    },
    async ({ token, lead_id, contact_id }) => {
      try {
        let q = supabaseAdmin.from("closure_submissions").select("*")
        if (token) {
          q = q.eq("token", token)
        } else if (lead_id) {
          q = q.eq("lead_id", lead_id)
        } else if (contact_id) {
          q = q.eq("contact_id", contact_id)
        } else {
          return { content: [{ type: "text" as const, text: "Provide token, lead_id, or contact_id." }] }
        }

        const { data, error } = await q.maybeSingle()
        if (error) throw new Error(error.message)
        if (!data) return { content: [{ type: "text" as const, text: "No closure form found." }] }

        // Get name
        let clientName = ""
        if (data.lead_id) {
          const { data: lead } = await supabaseAdmin.from("leads").select("full_name").eq("id", data.lead_id).single()
          clientName = lead?.full_name || ""
        }
        if (!clientName && data.contact_id) {
          const { data: contact } = await supabaseAdmin.from("contacts").select("first_name, last_name").eq("id", data.contact_id).single()
          clientName = contact ? `${contact.first_name} ${contact.last_name}`.trim() : ""
        }

        const changedCount = data.changed_fields ? Object.keys(data.changed_fields as object).length : 0

        const lines = [
          `📋 Closure Form: ${data.token}`,
          `   Client: ${clientName}`,
          `   Lang: ${data.language}`,
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

        const formUrl = `${APP_BASE_URL}/closure-form/${data.token}/${data.access_code}`
        lines.push("")
        lines.push(`   👁️ Admin Preview: ${formUrl}?preview=td`)
        lines.push(`   🔗 Client URL: ${formUrl}`)
        lines.push(`   ID: ${data.id}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // closure_form_review
  // ═══════════════════════════════════════
  server.tool(
    "closure_form_review",
    "Review a completed closure form submission. Shows all submitted data including LLC details, tax return history, and uploaded documents. Marks the form as reviewed. Always run without apply_changes first to review, then confirm with Antonio.",
    {
      token: z.string().describe("Form token to review"),
      mark_reviewed: z.boolean().optional().default(false).describe("If true, mark the form as reviewed"),
    },
    async ({ token, mark_reviewed }) => {
      try {
        const { data: sub, error } = await supabaseAdmin
          .from("closure_submissions")
          .select("*")
          .eq("token", token)
          .single()
        if (error || !sub) throw new Error(`Form not found: ${token}`)

        if (sub.status !== "completed" && sub.status !== "reviewed") {
          return { content: [{ type: "text" as const, text: `⚠️ Form status is "${sub.status}" — not yet completed by client.` }] }
        }

        const submitted = sub.submitted_data as Record<string, unknown> || {}

        // Get client name
        let clientName = token
        if (sub.lead_id) {
          const { data: lead } = await supabaseAdmin.from("leads").select("full_name").eq("id", sub.lead_id).single()
          clientName = lead?.full_name || token
        }

        const lines = [
          `═══════════════════════════════════════`,
          `  🏢 CLOSURE FORM REVIEW: ${clientName}`,
          `  Language: ${sub.language}`,
          `═══════════════════════════════════════`,
          "",
          "👤 Contact Info:",
          `   Name: ${submitted.owner_first_name || ""} ${submitted.owner_last_name || ""}`,
          `   Email: ${submitted.owner_email || ""}`,
          `   Phone: ${submitted.owner_phone || ""}`,
          "",
          "🏛️ LLC to Close:",
          `   Name: ${submitted.llc_name || "—"}`,
          `   EIN: ${submitted.llc_ein || "—"}`,
          `   State: ${submitted.llc_state || "—"}`,
          `   Formation Year: ${submitted.llc_formation_year || "—"}`,
          `   Registered Agent: ${submitted.registered_agent || "—"}`,
          "",
          "📊 Tax History:",
          `   Returns Filed: ${submitted.tax_returns_filed || "—"}`,
          `   Years: ${submitted.tax_returns_years || "—"}`,
        ]

        // Changes
        const changes = sub.changed_fields as Record<string, { old: unknown; new: unknown }> | null
        const changeCount = changes ? Object.keys(changes).length : 0
        if (changeCount > 0) {
          lines.push("")
          lines.push(`🔄 ${changeCount} field(s) changed from pre-filled:`)
          lines.push("| Field | Pre-filled | Client Value |")
          lines.push("|-------|-----------|-------------|")
          for (const [key, val] of Object.entries(changes!)) {
            const oldVal = val.old === null || val.old === "" ? "(empty)" : String(val.old)
            lines.push(`| ${key} | ${oldVal} | ${String(val.new)} |`)
          }
        }

        // Uploads
        const uploads = sub.upload_paths as string[] | null
        if (uploads && uploads.length > 0) {
          lines.push("")
          lines.push(`📎 ${uploads.length} file(s) uploaded:`)
          for (const path of uploads) {
            lines.push(`   • ${path}`)
          }
        }

        lines.push("")
        lines.push(`Submitted: ${sub.completed_at}`)

        if (mark_reviewed) {
          // Save form data + uploads to Drive
          try {
            const { saveFormToDrive } = await import("@/lib/form-to-drive")
            const driveFolderId = sub.account_id
              ? (await supabaseAdmin.from("accounts").select("drive_folder_id").eq("id", sub.account_id).single()).data?.drive_folder_id
              : null
            if (driveFolderId) {
              const driveResult = await saveFormToDrive(
                "closure",
                submitted,
                (sub.upload_paths as string[]) || [],
                driveFolderId,
                { token, submittedAt: sub.completed_at || new Date().toISOString(), companyName: clientName || token }
              )
              if (driveResult.summaryFileId) lines.push(`✅ Data summary saved to Drive (${driveResult.summaryFileId})`)
              if (driveResult.copied.length > 0) lines.push(`✅ ${driveResult.copied.length} file(s) copied to Drive`)
              if (driveResult.failed.length > 0) lines.push(`⚠️ ${driveResult.failed.length} file(s) failed to copy`)
              if (driveResult.errors.length > 0) lines.push(`⚠️ Drive errors: ${driveResult.errors.join(", ")}`)
            } else {
              lines.push("⚠️ No Drive folder found — data not saved to Drive")
            }
          } catch (driveErr) {
            lines.push(`⚠️ Drive save failed: ${driveErr instanceof Error ? driveErr.message : String(driveErr)}`)
          }

          await supabaseAdmin
            .from("closure_submissions")
            .update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: "claude" })
            .eq("id", sub.id)
          lines.push("")
          lines.push("✅ Form marked as reviewed.")
          lines.push("")
          lines.push("➡️ Next steps:")
          lines.push("   1. Create service_delivery: sd_create(service_type='Company Closure', ...)")
          lines.push("   2. Check Secretary of State for outstanding fees")
          lines.push("   3. Proceed with dissolution filing")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

} // end registerClosureTools
