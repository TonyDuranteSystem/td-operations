/**
 * ITIN Form Tools - Create, retrieve, and review ITIN data collection forms.
 * Follows the same pattern as formation form tools (formation.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"

export function registerITINFormTools(server: McpServer) {

  // ***************************************
  // itin_form_create
  // ***************************************
  server.tool(
    "itin_form_create",
    `Create an ITIN data collection form for a client. Pre-fills owner info from lead or contact record. Returns the form URL (${APP_BASE_URL}/itin-form/{token}). Admin preview: append ?preview=td to bypass the email gate. ALWAYS provide the admin preview link after creating a form so Antonio can review it before sending. Use gmail_send to send the link to the client.`,
    {
      lead_id: z.string().uuid().optional().describe("Lead UUID (use for new clients)"),
      account_id: z.string().uuid().optional().describe("Account UUID (use for existing clients)"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (auto-detects primary contact if omitted)"),
      language: z.enum(["en", "it"]).optional().describe("Form language (auto-detected from lead/contact language if omitted)"),
    },
    async ({ lead_id, account_id, contact_id, language }) => {
      try {
        if (!lead_id && !account_id) {
          return { content: [{ type: "text" as const, text: "Provide either lead_id (new client) or account_id (existing client)." }] }
        }

        let fullName = ""
        let email = ""
        let phone = ""
        let detectedLang = "en"
        let resolvedContactId = contact_id || null

        // Get data from lead or account+contact
        if (lead_id) {
          const { data: lead, error: leadErr } = await supabaseAdmin
            .from("leads")
            .select("id, full_name, email, phone, language, status")
            .eq("id", lead_id)
            .single()
          if (leadErr || !lead) throw new Error(`Lead not found: ${leadErr?.message || lead_id}`)

          fullName = lead.full_name || ""
          email = lead.email || ""
          phone = lead.phone || ""
          detectedLang = lead.language === "Italian" || lead.language === "it" ? "it" : "en"

          // Check if contact already exists
          if (!resolvedContactId && lead.email) {
            const { data: contact } = await supabaseAdmin
              .from("contacts")
              .select("id")
              .eq("email", lead.email)
              .maybeSingle()
            resolvedContactId = contact?.id || null
          }
        } else if (account_id) {
          // Get primary contact for account
          if (!resolvedContactId) {
            const { data: links } = await supabaseAdmin
              .from("account_contacts")
              .select("contact_id")
              .eq("account_id", account_id)
              .limit(1)
            resolvedContactId = links?.[0]?.contact_id || null
          }

          if (resolvedContactId) {
            const { data: contact } = await supabaseAdmin
              .from("contacts")
              .select("id, full_name, email, phone, language, citizenship")
              .eq("id", resolvedContactId)
              .single()
            if (contact) {
              fullName = contact.full_name || ""
              email = contact.email || ""
              phone = contact.phone || ""
              detectedLang = contact.language === "Italian" || contact.language === "it" ? "it" : "en"
            }
          }
        }

        // Build prefilled data
        const nameParts = fullName.trim().split(/\s+/)
        const firstName = nameParts[0] || ""
        const lastName = nameParts.slice(1).join(" ") || ""

        const prefilled: Record<string, unknown> = {
          first_name: firstName,
          last_name: lastName,
          email: email,
          phone: phone,
        }

        // If contact exists, try to get more data
        if (resolvedContactId) {
          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("citizenship, date_of_birth")
            .eq("id", resolvedContactId)
            .single()
          if (contact) {
            if (contact.citizenship) prefilled.citizenship = contact.citizenship
            if (contact.date_of_birth) prefilled.dob = contact.date_of_birth
          }
        }

        // Generate token
        const slug = (fullName || "itin-form")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 30)
        const year = new Date().getFullYear()
        const token = `itin-${slug}-${year}`

        // Check for existing submission
        const { data: existing } = await supabaseAdmin
          .from("itin_submissions")
          .select("id, token, status")
          .eq("token", token)
          .maybeSingle()
        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ ITIN form already exists for ${fullName}\nToken: ${existing.token}\nStatus: ${existing.status}\nURL: ${APP_BASE_URL}/itin-form/${existing.token}`,
            }],
          }
        }

        // ITIN form is English-only per business rule
        const formLang = "en" as const

        // Insert
        const { data: submission, error: insErr } = await supabaseAdmin
          .from("itin_submissions")
          .insert({
            token,
            lead_id: lead_id || null,
            account_id: account_id || null,
            contact_id: resolvedContactId,
            language: formLang,
            prefilled_data: prefilled,
            status: "pending",
          })
          .select("id, token")
          .single()
        if (insErr) throw new Error(insErr.message)

        const url = `${APP_BASE_URL}/itin-form/${token}`
        const adminPreviewUrl = `${url}?preview=td`
        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ ITIN form created for ${fullName}`,
              `   Lang: ${formLang}`,
              `   ${lead_id ? `Lead: ${lead_id}` : `Account: ${account_id}`}`,
              `   Token: ${token}`,
              `   ID: ${submission.id}`,
              "",
              `   👁 Admin Preview: ${adminPreviewUrl}`,
              `   🌐 Client URL: ${url}`,
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

  // ***************************************
  // itin_form_get
  // ***************************************
  server.tool(
    "itin_form_get",
    "Get an ITIN data collection form by token, lead_id, or account_id. Returns prefilled data, submitted data, status, timestamps, and changed fields.",
    {
      token: z.string().optional().describe("Form token (e.g., 'itin-mario-rossi-2026')"),
      lead_id: z.string().uuid().optional().describe("Lead UUID"),
      account_id: z.string().uuid().optional().describe("Account UUID"),
    },
    async ({ token, lead_id, account_id }) => {
      try {
        let q = supabaseAdmin.from("itin_submissions").select("*")
        if (token) {
          q = q.eq("token", token)
        } else if (lead_id) {
          q = q.eq("lead_id", lead_id)
        } else if (account_id) {
          q = q.eq("account_id", account_id)
        } else {
          return { content: [{ type: "text" as const, text: "Provide token, lead_id, or account_id." }] }
        }

        const { data, error } = await q.maybeSingle()
        if (error) throw new Error(error.message)
        if (!data) return { content: [{ type: "text" as const, text: "No ITIN form found." }] }

        // Get name
        let clientName = ""
        if (data.lead_id) {
          const { data: lead } = await supabaseAdmin
            .from("leads")
            .select("full_name")
            .eq("id", data.lead_id)
            .single()
          clientName = lead?.full_name || ""
        }
        if (!clientName && data.contact_id) {
          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("full_name")
            .eq("id", data.contact_id)
            .single()
          clientName = contact?.full_name || ""
        }

        const changedCount = data.changed_fields ? Object.keys(data.changed_fields as object).length : 0

        const lines = [
          `📋 ITIN Form: ${data.token}`,
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
          lines.push("   📝 Changes detected:")
          for (const [key, val] of Object.entries(data.changed_fields as Record<string, { old: unknown; new: unknown }>)) {
            lines.push(`      ${key}: "${val.old}" -> "${val.new}"`)
          }
        }

        if (data.upload_paths && (data.upload_paths as string[]).length > 0) {
          lines.push("")
          lines.push(`   📎 Uploads: ${(data.upload_paths as string[]).length} files`)
        }

        const formUrl = `${APP_BASE_URL}/itin-form/${data.token}`
        const adminPreviewUrl = `${formUrl}?preview=td`

        lines.push("")
        lines.push(`   👁 Admin Preview: ${adminPreviewUrl}`)
        lines.push(`   🌐 Client URL: ${formUrl}`)
        lines.push(`   ID: ${data.id}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ***************************************
  // itin_form_review
  // ***************************************
  server.tool(
    "itin_form_review",
    "Review a completed ITIN form submission. Shows diff table of changed fields (pre-filled vs submitted). If apply_changes=true, updates CRM contact record with submitted data (DOB, nationality, address, passport info) and creates a task for W-7 preparation. Always run without apply_changes first to review, then confirm with Antonio before applying.",
    {
      token: z.string().describe("Form token to review"),
      apply_changes: z.boolean().optional().default(false).describe("If true, apply submitted data to CRM and create follow-up tasks"),
    },
    async ({ token, apply_changes }) => {
      try {
        const { data: sub, error } = await supabaseAdmin
          .from("itin_submissions")
          .select("*")
          .eq("token", token)
          .single()
        if (error || !sub) throw new Error(`Form not found: ${token}`)

        if (sub.status !== "completed") {
          return { content: [{ type: "text" as const, text: `⚠️ Form status is "${sub.status}" - not yet completed by client.` }] }
        }

        const changes = sub.changed_fields as Record<string, { old: unknown; new: unknown }> | null
        const changeCount = changes ? Object.keys(changes).length : 0
        const submitted = sub.submitted_data as Record<string, unknown> || {}

        // Get client name
        let clientName = token
        if (sub.lead_id) {
          const { data: lead } = await supabaseAdmin
            .from("leads")
            .select("full_name")
            .eq("id", sub.lead_id)
            .single()
          clientName = lead?.full_name || token
        }

        const lines = [
          `***************************************`,
          `  📋 ITIN FORM REVIEW: ${clientName}`,
          `  Language: ${sub.language}`,
          `***************************************`,
          "",
        ]

        // Show submitted data summary
        lines.push("👤 Personal Information:")
        lines.push(`   Name: ${submitted.first_name || ""} ${submitted.last_name || ""}`)
        if (submitted.name_at_birth) lines.push(`   Name at Birth: ${submitted.name_at_birth}`)
        lines.push(`   Email: ${submitted.email || ""}`)
        lines.push(`   Phone: ${submitted.phone || ""}`)
        lines.push(`   DOB: ${submitted.dob || ""}`)
        lines.push(`   Country of Birth: ${submitted.country_of_birth || ""}`)
        lines.push(`   City of Birth: ${submitted.city_of_birth || ""}`)
        lines.push(`   Gender: ${submitted.gender || ""}`)
        lines.push(`   Citizenship: ${submitted.citizenship || ""}`)

        lines.push("")
        lines.push("🏠 Foreign Address:")
        lines.push(`   ${submitted.foreign_street || ""}, ${submitted.foreign_city || ""} ${submitted.foreign_zip || ""}`)
        lines.push(`   ${submitted.foreign_state_province || ""} ${submitted.foreign_country || ""}`)
        if (submitted.foreign_tax_id) lines.push(`   Foreign Tax ID: ${submitted.foreign_tax_id}`)

        if (submitted.us_visa_type) {
          lines.push("")
          lines.push("üá∫üá∏ US Entry Info:")
          lines.push(`   Visa: ${submitted.us_visa_type} (${submitted.us_visa_number || "N/A"})`)
          if (submitted.us_entry_date) lines.push(`   Entry Date: ${submitted.us_entry_date}`)
        }

        lines.push("")
        lines.push("📄 Passport Information:")
        lines.push(`   Number: ${submitted.passport_number || ""}`)
        lines.push(`   Country: ${submitted.passport_country || ""}`)
        lines.push(`   Expires: ${submitted.passport_expiry || ""}`)
        lines.push(`   Previous ITIN: ${submitted.has_previous_itin || "No"}${submitted.previous_itin ? ` (${submitted.previous_itin})` : ""}`)

        lines.push("")

        if (changeCount === 0) {
          lines.push("✅ No changes detected - all pre-filled data was confirmed by client.")
        } else {
          lines.push(`📝 ${changeCount} field(s) changed from pre-filled:`)
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
          lines.push(`📎 ${uploads.length} file(s) uploaded:`)
          for (const path of uploads) {
            lines.push(`   • ${path}`)
          }
        }

        lines.push("")
        lines.push(`Submitted: ${sub.completed_at}`)

        if (apply_changes) {
          lines.push("")
          lines.push("===================================")
          lines.push("APPLYING CHANGES...")
          lines.push("")

          // Update contact with submitted data
          if (sub.contact_id) {
            const contactUpdates: Record<string, unknown> = {}
            if (submitted.first_name || submitted.last_name) {
              contactUpdates.full_name = `${submitted.first_name || ""} ${submitted.last_name || ""}`.trim()
            }
            if (submitted.email) contactUpdates.email = submitted.email
            if (submitted.phone) contactUpdates.phone = submitted.phone
            if (submitted.citizenship) contactUpdates.citizenship = submitted.citizenship
            if (submitted.dob) contactUpdates.date_of_birth = submitted.dob

            if (Object.keys(contactUpdates).length > 0) {
              await supabaseAdmin
                .from("contacts")
                .update(contactUpdates)
                .eq("id", sub.contact_id)
              lines.push(`✅ Contact updated (${Object.keys(contactUpdates).length} fields)`)
            }
          }

          // Create task for W-7 preparation
          const accountId = sub.account_id || null
          await supabaseAdmin
            .from("tasks")
            .insert({
              task_title: `Prepare W-7 form for ${clientName}`,
              description: `ITIN form submitted (${token}). Prepare W-7 + 1040-NR for client signature. Passport copies uploaded.`,
              assigned_to: "Luca",
              category: "Document",
              priority: "High",
              status: "To Do",
              account_id: accountId,
            })
          lines.push("✅ Task created: Prepare W-7 form")

          // Mark form as reviewed
          await supabaseAdmin
            .from("itin_submissions")
            .update({
              status: "reviewed",
              reviewed_at: new Date().toISOString(),
              reviewed_by: "claude",
            })
            .eq("id", sub.id)
          lines.push("✅ Form marked as reviewed")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

} // end registerITINFormTools
