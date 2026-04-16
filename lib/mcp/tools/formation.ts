/**
 * Formation Form Tools — Create, retrieve, and review LLC formation data collection forms.
 * Follows the same pattern as tax form tools (tax.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import type { Json } from "@/lib/database.types"

export function registerFormationTools(server: McpServer) {

  // ═══════════════════════════════════════
  // formation_form_create
  // ═══════════════════════════════════════
  server.tool(
    "formation_form_create",
    `Create a formation data collection form for a new LLC client. Pre-fills owner info from the lead record. Entity type (SMLLC/MMLLC) and state are set as metadata — decided during the call, not by the client. Returns the form URL (${APP_BASE_URL}/formation-form/{token}/{access_code}). Admin preview: append ?preview=td to the form URL to bypass the email gate. ALWAYS provide the admin preview link after creating a form so Antonio can review it before sending. Use gmail_send to send the link to the client.`,
    {
      lead_id: z.string().uuid().describe("Lead UUID — the client who paid for formation"),
      entity_type: z.enum(["SMLLC", "MMLLC"]).optional().default("SMLLC").describe("Entity type decided during call (default: SMLLC)"),
      state: z.string().optional().default("NM").describe("State of formation decided during call (default: NM)"),
      language: z.enum(["en", "it"]).optional().describe("Form language (auto-detected from lead.language if omitted)"),
    },
    async ({ lead_id, entity_type, state, language }) => {
      try {
        // 1. Get lead data
        const { data: lead, error: leadErr } = await supabaseAdmin
          .from("leads")
          .select("id, full_name, email, phone, language, status")
          .eq("id", lead_id)
          .single()
        if (leadErr || !lead) throw new Error(`Lead not found: ${leadErr?.message || lead_id}`)

        // 2. Check if contact already exists (lead may have been converted)
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

        // 4. Generate token
        const slug = (lead.full_name || "form")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 30)
        const year = new Date().getFullYear()
        const token = `${slug}-${year}`

        // 5. Check for existing submission
        const { data: existing } = await supabaseAdmin
          .from("formation_submissions")
          .select("id, token, status, access_code")
          .eq("token", token)
          .maybeSingle()
        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Form already exists for ${lead.full_name}\nToken: ${existing.token}\nStatus: ${existing.status}\nURL: ${APP_BASE_URL}/formation-form/${existing.token}/${existing.access_code}`,
            }],
          }
        }

        // 6. Determine language
        const formLang = language || (lead.language === "Italian" || lead.language === "it" ? "it" : "en")

        // 7. Insert
        const { data: submission, error: insErr } = await supabaseAdmin
          .from("formation_submissions")
          .insert({
            token,
            lead_id,
            contact_id: contactId,
            entity_type: entity_type || "SMLLC",
            state: state || "NM",
            language: formLang,
            prefilled_data: prefilled as unknown as Json,
            status: "pending",
          })
          .select("id, token, access_code")
          .single()
        if (insErr) throw new Error(insErr.message)

        const url = `${APP_BASE_URL}/formation-form/${token}/${submission.access_code}`
        const adminPreviewUrl = `${url}?preview=td`
        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Formation form created for ${lead.full_name}`,
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
  // formation_form_get
  // ═══════════════════════════════════════
  server.tool(
    "formation_form_get",
    "Get a formation data collection form by token or lead_id. Returns prefilled data, submitted data, status, timestamps, and changed fields. Use this to check form status or review client submissions.",
    {
      token: z.string().optional().describe("Form token (e.g., 'mario-rossi-2026')"),
      lead_id: z.string().uuid().optional().describe("Lead UUID"),
    },
    async ({ token, lead_id }) => {
      try {
        let q = supabaseAdmin.from("formation_submissions").select("*")
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

        // Get lead name
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
          `📋 Formation Form: ${data.token}`,
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

        const formUrl = `${APP_BASE_URL}/formation-form/${data.token}/${data.access_code}`
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
  // formation_form_review
  // ═══════════════════════════════════════
  server.tool(
    "formation_form_review",
    "Review a completed formation form submission. Shows diff table of changed fields (pre-filled vs submitted). If apply_changes=true, updates the Contact CRM record with submitted data (address, DOB, nationality) and marks lead as Converted. Always run without apply_changes first to review, then confirm with Antonio before applying.",
    {
      token: z.string().describe("Form token to review"),
      apply_changes: z.boolean().optional().default(false).describe("If true, apply submitted data to CRM contact and mark lead as Converted"),
    },
    async ({ token, apply_changes }) => {
      try {
        const { data: sub, error } = await supabaseAdmin
          .from("formation_submissions")
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

        // Get lead name
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
          `  📋 FORMATION FORM REVIEW: ${leadName}`,
          `  ${sub.entity_type} | ${sub.state} | ${sub.language}`,
          `═══════════════════════════════════════`,
          "",
        ]

        // Show submitted data summary
        lines.push("📝 Submitted Data:")
        lines.push(`   Owner: ${submitted.owner_first_name || ""} ${submitted.owner_last_name || ""}`)
        lines.push(`   Email: ${submitted.owner_email || ""}`)
        lines.push(`   Phone: ${submitted.owner_phone || ""}`)
        lines.push(`   DOB: ${submitted.owner_dob || ""}`)
        lines.push(`   Nationality: ${submitted.owner_nationality || ""}`)
        lines.push(`   Address: ${submitted.owner_street || ""}, ${submitted.owner_city || ""} ${submitted.owner_zip || ""}, ${submitted.owner_country || ""}`)
        lines.push(`   LLC Name (1st): ${submitted.llc_name_1 || ""}`)
        if (submitted.llc_name_2) lines.push(`   LLC Name (2nd): ${submitted.llc_name_2}`)
        if (submitted.llc_name_3) lines.push(`   LLC Name (3rd): ${submitted.llc_name_3}`)
        lines.push(`   Purpose: ${submitted.business_purpose || ""}`)

        // Show members if MMLLC
        const members = submitted.additional_members as Record<string, string>[] | undefined
        if (members && members.length > 0) {
          lines.push("")
          lines.push(`   👥 Additional Members (${members.length}):`)
          for (const m of members) {
            lines.push(`      • ${m.member_first_name || ""} ${m.member_last_name || ""} — ${m.member_ownership_pct || "?"}% (${m.member_email || ""})`)
          }
        }

        lines.push("")

        if (changeCount === 0) {
          lines.push("✅ No changes detected — all pre-filled data was confirmed by client.")
        } else {
          lines.push(`🔄 ${changeCount} field(s) changed from pre-filled:`)
          lines.push("")
          lines.push("| Field | Pre-filled | Client Value |")
          lines.push("|-------|-----------|-------------|")
          for (const [key, val] of Object.entries(changes!)) {
            const oldVal = val.old === null || val.old === "" ? "(empty)" : String(val.old)
            const newVal = String(val.new)
            lines.push(`| ${key} | ${oldVal} | ${newVal} |`)
          }
        }

        // Upload info
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

        if (apply_changes) {
          lines.push("")
          lines.push("───────────────────────────────────")
          lines.push("APPLYING CHANGES...")
          lines.push("")

          // Save form data + uploads to Drive
          try {
            const { saveFormToDrive } = await import("@/lib/form-to-drive")
            const driveFolderId = sub.lead_id
              ? await (async () => {
                  // Try to find account via contact linked to lead
                  const { data: contact } = await supabaseAdmin
                    .from("contacts")
                    .select("id")
                    .eq("email", String(submitted.owner_email || ""))
                    .maybeSingle()
                  if (contact?.id) {
                    const { data: ac } = await supabaseAdmin
                      .from("account_contacts")
                      .select("account_id")
                      .eq("contact_id", contact.id)
                      .limit(1)
                      .maybeSingle()
                    if (ac?.account_id) {
                      const { data: acct } = await supabaseAdmin
                        .from("accounts")
                        .select("drive_folder_id")
                        .eq("id", ac.account_id)
                        .single()
                      return acct?.drive_folder_id || null
                    }
                  }
                  return null
                })()
              : null
            if (driveFolderId) {
              const driveResult = await saveFormToDrive(
                "formation",
                submitted,
                (sub.upload_paths as string[]) || [],
                driveFolderId,
                { token, submittedAt: sub.completed_at || new Date().toISOString(), companyName: leadName || token }
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

          lines.push("")
          lines.push("ENQUEUING BACKGROUND JOB...")
          lines.push("")

          // Enqueue async job for CRM updates
          const { enqueueJob } = await import("@/lib/jobs/queue")
          const { id: jobId } = await enqueueJob({
            job_type: "formation_setup",
            payload: {
              token: sub.token,
              submission_id: sub.id,
              contact_id: sub.contact_id || null,
              lead_id: sub.lead_id || null,
              submitted_data: submitted,
            },
            priority: 1,
            max_attempts: 3,
            lead_id: sub.lead_id || undefined,
            related_entity_type: "formation_submission",
            related_entity_id: sub.id,
            created_by: "claude",
          })

          lines.push(`✅ Background job enqueued: ${jobId}`)
          lines.push(`   Steps: Contact update → Lead → Converted → Form → reviewed`)
          lines.push("")
          lines.push(`➡️ Check progress: job_status('${jobId}')`)

          // Upgrade portal tier: onboarding → active
          const formAccountId = (sub as Record<string, unknown>).account_id as string | undefined
          if (formAccountId) {
            await supabaseAdmin
              .from("accounts")
              .update({ portal_tier: "active", updated_at: new Date().toISOString() })
              .eq("id", formAccountId)
              .in("portal_tier", ["onboarding"])
            lines.push(`🔓 Portal tier upgraded: onboarding → active`)
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // formation_confirm
  // ═══════════════════════════════════════
  server.tool(
    "formation_confirm",
    `Review and execute service activation steps. activate-service now auto-executes all steps immediately (supervised mode removed — it caused silent failures). Invoices are created at contract signing and marked Paid on payment. Works for ALL contract types: formation, onboarding, tax_return, itin. Use this tool to:
1. View prepared steps (without execute=true)
2. Execute any remaining steps (with execute=true)

Note: Steps are now auto-executed at payment. This tool is for manual recovery only.`,
    {
      activation_id: z.string().uuid().describe("Pending activation UUID"),
      execute: z.boolean().optional().default(false).describe("If true, execute all prepared steps. If false (default), just show what will be done."),
    },
    async ({ activation_id, execute }) => {
      try {
        const { data: activation, error } = await supabaseAdmin
          .from("pending_activations")
          .select("*")
          .eq("id", activation_id)
          .single()

        if (error || !activation) {
          return { content: [{ type: "text" as const, text: `❌ Activation not found: ${activation_id}` }] }
        }

        const preparedSteps = (activation.prepared_steps || []) as Array<{
          step: string
          action: string
          description: string
          params: Record<string, unknown>
          status: string
        }>

        if (preparedSteps.length === 0) {
          return { content: [{ type: "text" as const, text: `⚠️ No prepared steps for activation ${activation_id} (status: ${activation.status})` }] }
        }

        const lines = [
          `═══════════════════════════════════════`,
          `  🔍 FORMATION CONFIRMATION: ${activation.client_name}`,
          `  Status: ${activation.status} | Mode: ${activation.confirmation_mode}`,
          `═══════════════════════════════════════`,
          ``,
        ]

        // Show prepared steps
        for (const ps of preparedSteps) {
          lines.push(`📋 Step ${ps.step}: ${ps.action}`)
          lines.push(`   ${ps.description}`)
          lines.push(`   Status: ${ps.status}`)
          lines.push(``)
        }

        if (!execute) {
          lines.push(`───────────────────────────────────`)
          lines.push(`To execute these steps, call:`)
          lines.push(`formation_confirm(activation_id="${activation_id}", execute=true)`)
          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        // ─── EXECUTE PREPARED STEPS ───
        if (activation.status !== "pending_confirmation") {
          return { content: [{ type: "text" as const, text: `⚠️ Activation status is "${activation.status}" — expected "pending_confirmation".` }] }
        }

        lines.push(`───────────────────────────────────`)
        lines.push(`EXECUTING STEPS...`)
        lines.push(``)

        const executionResults: Array<{ step: string; status: string; detail?: string }> = []

        for (const ps of preparedSteps) {
          // Mark as confirmed
          ps.status = "confirmed"

          // For now, create CRM tasks with full context
          // These will be replaced with direct API calls as we build confidence
          // Step 0.3 (QB Invoice) removed — invoices now created automatically by activate-service Step 3

          if (ps.step === "0.6" || ps.step === "data_form") {
            const params = ps.params as Record<string, string>
            // Create formation form directly
            const slug = (params.client_name || "form")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 30)
            const year = new Date().getFullYear()
            const formToken = `${slug}-${year}`

            // Check if already exists
            const { data: existing } = await supabaseAdmin
              .from("formation_submissions")
              .select("id, token")
              .eq("token", formToken)
              .maybeSingle()

            if (existing) {
              executionResults.push({ step: ps.step, status: "existing", detail: `Form already exists: ${existing.token}` })
            } else {
              // Find contact for pre-fill
              let contactId: string | null = null
              if (params.client_email) {
                const { data: contact } = await supabaseAdmin
                  .from("contacts")
                  .select("id")
                  .eq("email", params.client_email)
                  .maybeSingle()
                contactId = contact?.id || null
              }

              const nameParts = (params.client_name || "").trim().split(/\s+/)
              const firstName = nameParts[0] || ""
              const lastName = nameParts.slice(1).join(" ") || ""

              const { data: submission, error: insErr } = await supabaseAdmin
                .from("formation_submissions")
                .insert({
                  token: formToken,
                  lead_id: params.lead_id,
                  contact_id: contactId,
                  entity_type: params.entity_type || "SMLLC",
                  state: params.state || "NM",
                  language: params.language || "en",
                  prefilled_data: {
                    owner_first_name: firstName,
                    owner_last_name: lastName,
                    owner_email: params.client_email || "",
                  },
                  status: "pending",
                })
                .select("id, token, access_code")
                .single()

              if (insErr) {
                executionResults.push({ step: ps.step, status: "error", detail: insErr.message })
              } else {
                ps.status = "executed"
                const formUrl = `${APP_BASE_URL}/formation-form/${submission.token}/${submission.access_code}`
                executionResults.push({
                  step: ps.step,
                  status: "ok",
                  detail: `Form created: ${submission.token}. URL: ${formUrl}. Send to client via gmail_send.`,
                })
              }
            }
          }
        }

        // Update activation: mark as activated
        await supabaseAdmin
          .from("pending_activations")
          .update({
            status: "activated",
            prepared_steps: preparedSteps as unknown as Json,
            activated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", activation_id)

        // Log successful confirmation
        await supabaseAdmin.from("action_log").insert({
          action_type: "formation_confirmed",
          table_name: "pending_activations",
          record_id: activation_id,
          summary: `Formation confirmed for activation ${activation_id}`,
          details: { execution_results: executionResults } as unknown as Json,
        })

        for (const r of executionResults) {
          lines.push(`${r.status === "ok" ? "✅" : r.status === "existing" ? "⚠️" : "❌"} Step ${r.step}: ${r.detail}`)
        }

        lines.push(``)
        lines.push(`✅ Activation confirmed and executed.`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

} // end registerFormationTools
