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

  // ***************************************
  // itin_prepare_documents
  // ***************************************
  server.tool(
    "itin_prepare_documents",
    `Generate W-7, 1040-NR, and Schedule OI PDFs from a completed ITIN form submission. Uploads all 3 PDFs + passport copies to the client's Google Drive folder (ITIN subfolder). Optionally sends email to client with PDFs attached and mailing instructions. Prerequisites: 1) ITIN form must be 'completed' or 'reviewed', 2) Client must have an account with drive_folder_id (for LLC clients) OR a contact record (for individual clients). Run itin_form_review first to verify data, then use this tool to generate documents.`,
    {
      token: z.string().describe("ITIN form token"),
      send_email: z.boolean().optional().default(false).describe("If true, send email to client with PDFs and mailing instructions"),
      drive_folder_id: z.string().optional().describe("Override Drive folder ID (auto-detected from account if omitted)"),
    },
    async ({ token, send_email, drive_folder_id }) => {
      try {
        // 1. Load submission
        const { data: sub, error } = await supabaseAdmin
          .from("itin_submissions")
          .select("*")
          .eq("token", token)
          .single()
        if (error || !sub) throw new Error(`Form not found: ${token}`)
        if (!["completed", "reviewed"].includes(sub.status)) {
          return { content: [{ type: "text" as const, text: `⚠️ Form status is "${sub.status}" - must be completed or reviewed first.` }] }
        }

        const submitted = sub.submitted_data as Record<string, unknown> || {}
        const clientName = `${submitted.first_name || ""} ${submitted.last_name || ""}`.trim() || token

        const results: string[] = [`📋 ITIN Document Preparation: ${clientName}`, ""]

        // 2. Resolve Drive folder
        let folderId = drive_folder_id
        if (!folderId && sub.account_id) {
          const { data: acc } = await supabaseAdmin
            .from("accounts")
            .select("drive_folder_id, company_name")
            .eq("id", sub.account_id)
            .single()
          folderId = acc?.drive_folder_id || undefined
        }

        // Create ITIN subfolder
        let itinFolderId: string | undefined
        if (folderId) {
          const { listFolder, createFolder } = await import("@/lib/google-drive")
          const contents = await listFolder(folderId)
          const existing = contents?.files?.find(
            (f: { name: string; mimeType: string }) => f.name === "ITIN" && f.mimeType === "application/vnd.google-apps.folder"
          )
          if (existing) {
            itinFolderId = existing.id
          } else {
            const newFolder = await createFolder(folderId, "ITIN")
            itinFolderId = newFolder.id
          }
          results.push(`📁 Drive folder: ITIN/ (${itinFolderId})`)
        } else {
          results.push("⚠️ No Drive folder found - PDFs will be generated but not uploaded")
        }

        // 3. Generate W-7
        const { fillW7 } = await import("@/lib/pdf/w7-fill")
        const w7Pdf = await fillW7({
          first_name: String(submitted.first_name || ""),
          last_name: String(submitted.last_name || ""),
          name_at_birth: submitted.name_at_birth ? String(submitted.name_at_birth) : undefined,
          foreign_street: String(submitted.foreign_street || ""),
          foreign_city: String(submitted.foreign_city || ""),
          foreign_state_province: submitted.foreign_state_province ? String(submitted.foreign_state_province) : undefined,
          foreign_zip: String(submitted.foreign_zip || ""),
          foreign_country: String(submitted.foreign_country || ""),
          dob: String(submitted.dob || ""),
          country_of_birth: String(submitted.country_of_birth || ""),
          city_of_birth: String(submitted.city_of_birth || ""),
          gender: (submitted.gender as "Male" | "Female") || "Male",
          citizenship: String(submitted.citizenship || ""),
          foreign_tax_id: submitted.foreign_tax_id ? String(submitted.foreign_tax_id) : undefined,
          us_visa_type: submitted.us_visa_type ? String(submitted.us_visa_type) : undefined,
          us_visa_number: submitted.us_visa_number ? String(submitted.us_visa_number) : undefined,
          us_entry_date: submitted.us_entry_date ? String(submitted.us_entry_date) : undefined,
          passport_number: String(submitted.passport_number || ""),
          passport_country: String(submitted.passport_country || ""),
          passport_expiry: String(submitted.passport_expiry || ""),
          has_previous_itin: submitted.has_previous_itin === "Yes",
          previous_itin: submitted.previous_itin ? String(submitted.previous_itin) : undefined,
        })
        results.push(`✅ W-7 generated (${w7Pdf.length} bytes)`)

        // 4. Generate 1040-NR
        const { fill1040NR, fillScheduleOI } = await import("@/lib/pdf/1040nr-fill")
        const nrData = {
          first_name: String(submitted.first_name || ""),
          last_name: String(submitted.last_name || ""),
          citizenship: String(submitted.citizenship || ""),
          foreign_country: String(submitted.foreign_country || ""),
          foreign_state_province: submitted.foreign_state_province ? String(submitted.foreign_state_province) : undefined,
          foreign_zip: submitted.foreign_zip ? String(submitted.foreign_zip) : undefined,
          us_visa_type: submitted.us_visa_type ? String(submitted.us_visa_type) : undefined,
        }
        const nrPdf = await fill1040NR(nrData)
        results.push(`✅ 1040-NR generated (${nrPdf.length} bytes)`)

        // 5. Generate Schedule OI
        const oiPdf = await fillScheduleOI(nrData)
        results.push(`✅ Schedule OI generated (${oiPdf.length} bytes)`)

        // 5b. Generate data summary PDF
        const { generateITINSummaryPDF } = await import("@/lib/pdf/itin-data-summary")
        const summaryPdf = await generateITINSummaryPDF({
          first_name: String(submitted.first_name || ""),
          last_name: String(submitted.last_name || ""),
          name_at_birth: submitted.name_at_birth ? String(submitted.name_at_birth) : undefined,
          email: String(submitted.email || ""),
          phone: String(submitted.phone || ""),
          dob: String(submitted.dob || ""),
          country_of_birth: String(submitted.country_of_birth || ""),
          city_of_birth: String(submitted.city_of_birth || ""),
          gender: String(submitted.gender || ""),
          citizenship: String(submitted.citizenship || ""),
          foreign_street: String(submitted.foreign_street || ""),
          foreign_city: String(submitted.foreign_city || ""),
          foreign_state_province: submitted.foreign_state_province ? String(submitted.foreign_state_province) : undefined,
          foreign_zip: String(submitted.foreign_zip || ""),
          foreign_country: String(submitted.foreign_country || ""),
          foreign_tax_id: submitted.foreign_tax_id ? String(submitted.foreign_tax_id) : undefined,
          us_visa_type: submitted.us_visa_type ? String(submitted.us_visa_type) : undefined,
          us_visa_number: submitted.us_visa_number ? String(submitted.us_visa_number) : undefined,
          us_entry_date: submitted.us_entry_date ? String(submitted.us_entry_date) : undefined,
          passport_number: String(submitted.passport_number || ""),
          passport_country: String(submitted.passport_country || ""),
          passport_expiry: String(submitted.passport_expiry || ""),
          has_previous_itin: String(submitted.has_previous_itin || "No"),
          previous_itin: submitted.previous_itin ? String(submitted.previous_itin) : undefined,
          submitted_at: sub.completed_at || new Date().toISOString(),
          token,
          upload_count: (sub.upload_paths as string[] || []).length,
        })
        results.push(`✅ Data summary generated (${summaryPdf.length} bytes)`)

        // 6. Upload to Drive
        const uploadedIds: { name: string; id: string }[] = []
        if (itinFolderId) {
          const { uploadBinaryToDrive } = await import("@/lib/google-drive")
          const slug = clientName.replace(/\s+/g, "_")

          const w7Upload = await uploadBinaryToDrive(
            `W-7_${slug}.pdf`, Buffer.from(w7Pdf), "application/pdf", itinFolderId
          )
          uploadedIds.push({ name: "W-7", id: w7Upload.id })
          results.push(`📤 W-7 uploaded to Drive (${w7Upload.id})`)

          const nrUpload = await uploadBinaryToDrive(
            `1040-NR_${slug}.pdf`, Buffer.from(nrPdf), "application/pdf", itinFolderId
          )
          uploadedIds.push({ name: "1040-NR", id: nrUpload.id })
          results.push(`📤 1040-NR uploaded to Drive (${nrUpload.id})`)

          const oiUpload = await uploadBinaryToDrive(
            `Schedule_OI_${slug}.pdf`, Buffer.from(oiPdf), "application/pdf", itinFolderId
          )
          uploadedIds.push({ name: "Schedule OI", id: oiUpload.id })
          results.push(`📤 Schedule OI uploaded to Drive (${oiUpload.id})`)

          // Upload data summary
          const summaryUpload = await uploadBinaryToDrive(
            `ITIN_Data_Summary_${slug}.pdf`, Buffer.from(summaryPdf), "application/pdf", itinFolderId
          )
          uploadedIds.push({ name: "Data Summary", id: summaryUpload.id })
          results.push(`📤 Data summary uploaded to Drive (${summaryUpload.id})`)

          // Copy passport scans from Supabase Storage to Drive
          const uploads = sub.upload_paths as string[] | null
          if (uploads && uploads.length > 0) {
            for (const path of uploads) {
              try {
                const fileName = path.split("/").pop() || "passport.pdf"
                const { data: fileData } = await supabaseAdmin.storage
                  .from("onboarding-uploads")
                  .download(path)
                if (fileData) {
                  const buf = Buffer.from(await fileData.arrayBuffer())
                  const passUpload = await uploadBinaryToDrive(
                    fileName, buf, fileData.type || "application/octet-stream", itinFolderId
                  )
                  uploadedIds.push({ name: fileName, id: passUpload.id })
                  results.push(`📤 Passport copy uploaded (${passUpload.id})`)
                }
              } catch (e) {
                results.push(`⚠️ Failed to copy ${path}: ${e instanceof Error ? e.message : String(e)}`)
              }
            }
          }
        }

        // 7. Send email to client
        if (send_email) {
          const clientEmail = String(submitted.email || "")
          if (!clientEmail) {
            results.push("⚠️ Cannot send email: no client email address")
          } else if (uploadedIds.length < 3) {
            results.push("⚠️ Cannot send email: PDFs not uploaded to Drive")
          } else {
            try {
              const w7FileId = uploadedIds.find(u => u.name === "W-7")?.id
              const nrFileId = uploadedIds.find(u => u.name === "1040-NR")?.id
              const oiFileId = uploadedIds.find(u => u.name === "Schedule OI")?.id

              if (w7FileId && nrFileId && oiFileId) {
                // Build HTML email
                const emailHtml = generateITINSigningEmail(String(submitted.first_name || ""))

                const { gmailPost } = await import("@/lib/gmail")
                const { downloadFileBinary } = await import("@/lib/google-drive")
                const { buffer: w7Buf } = await downloadFileBinary(w7FileId)
                const { buffer: nrBuf } = await downloadFileBinary(nrFileId)
                const { buffer: oiBuf } = await downloadFileBinary(oiFileId)

                const boundary = "boundary_" + Date.now()
                const slug2 = clientName.replace(/\s+/g, "_")
                const parts = [
                  `--${boundary}`,
                  `Content-Type: text/html; charset=utf-8`,
                  `Content-Transfer-Encoding: base64`,
                  "",
                  Buffer.from(emailHtml).toString("base64"),
                  `--${boundary}`,
                  `Content-Type: application/pdf; name="W-7_${slug2}.pdf"`,
                  `Content-Transfer-Encoding: base64`,
                  `Content-Disposition: attachment; filename="W-7_${slug2}.pdf"`,
                  "",
                  Buffer.from(w7Buf).toString("base64"),
                  `--${boundary}`,
                  `Content-Type: application/pdf; name="1040-NR_${slug2}.pdf"`,
                  `Content-Transfer-Encoding: base64`,
                  `Content-Disposition: attachment; filename="1040-NR_${slug2}.pdf"`,
                  "",
                  Buffer.from(nrBuf).toString("base64"),
                  `--${boundary}`,
                  `Content-Type: application/pdf; name="Schedule_OI_${slug2}.pdf"`,
                  `Content-Transfer-Encoding: base64`,
                  `Content-Disposition: attachment; filename="Schedule_OI_${slug2}.pdf"`,
                  "",
                  Buffer.from(oiBuf).toString("base64"),
                  `--${boundary}--`,
                ]

                const mimeMessage = [
                  `From: Tony Durante LLC <support@tonydurante.us>`,
                  `To: ${clientEmail}`,
                  `Subject: Your ITIN Application Documents - Ready for Signature`,
                  `MIME-Version: 1.0`,
                  `Content-Type: multipart/mixed; boundary="${boundary}"`,
                  "",
                  ...parts,
                ].join("\r\n")

                const encodedRaw = Buffer.from(mimeMessage).toString("base64url")
                await gmailPost("/messages/send", { raw: encodedRaw })
                results.push(`📧 Email sent to ${clientEmail} with 3 PDF attachments`)
              }
            } catch (e) {
              results.push(`⚠️ Email failed: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }

        results.push("")
        results.push("---")
        if (!send_email) {
          results.push("Documents generated and uploaded. To send to client, run again with send_email=true")
        }

        return { content: [{ type: "text" as const, text: results.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

} // end registerITINFormTools

// ─── ITIN Signing Email Template (HTML) ───

function generateITINSigningEmail(firstName: string): string {
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1a1a1a;max-width:640px;margin:0 auto">

<p>Dear ${firstName},</p>

<p>Your ITIN application documents are ready. Please find attached:</p>

<ol style="margin:16px 0">
<li><strong>Form W-7</strong> &mdash; Application for IRS Individual Taxpayer Identification Number</li>
<li><strong>Form 1040-NR</strong> &mdash; U.S. Nonresident Alien Income Tax Return</li>
<li><strong>Schedule OI</strong> &mdash; Other Information (attached to 1040-NR)</li>
</ol>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />

<p style="font-size:16px"><strong>What you need to do</strong></p>

<table style="border-collapse:collapse;width:100%;margin:12px 0">
<tr>
<td style="padding:10px 12px;background:#f0f5fb;border:1px solid #d1d5db;font-weight:bold;width:32px;text-align:center;color:#1e3a5f">1</td>
<td style="padding:10px 12px;border:1px solid #d1d5db"><strong>Print</strong> all three documents</td>
</tr>
<tr>
<td style="padding:10px 12px;background:#f0f5fb;border:1px solid #d1d5db;font-weight:bold;text-align:center;color:#1e3a5f">2</td>
<td style="padding:10px 12px;border:1px solid #d1d5db"><strong>Sign the W-7</strong> on the <em>"Signature of applicant"</em> line (wet ink signature required &mdash; no digital signatures)</td>
</tr>
<tr>
<td style="padding:10px 12px;background:#f0f5fb;border:1px solid #d1d5db;font-weight:bold;text-align:center;color:#1e3a5f">3</td>
<td style="padding:10px 12px;border:1px solid #d1d5db"><strong>Sign the 1040-NR</strong> on page 2, <em>"Your signature"</em> line (wet ink signature required)</td>
</tr>
<tr>
<td style="padding:10px 12px;background:#f0f5fb;border:1px solid #d1d5db;font-weight:bold;text-align:center;color:#1e3a5f">4</td>
<td style="padding:10px 12px;border:1px solid #d1d5db"><strong>Mail all signed documents</strong> to the address below</td>
</tr>
</table>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />

<p style="font-size:16px"><strong>Mailing address</strong></p>

<div style="background:#f7f8fa;border:1px solid #d1d5db;border-radius:8px;padding:16px 20px;margin:12px 0;font-size:15px">
<strong>Tony Durante LLC</strong><br/>
10225 Ulmerton Rd, Suite 3D<br/>
Largo, FL 33771<br/>
United States
</div>

<p style="color:#b8292f;font-weight:600">Please use a trackable shipping method (FedEx, DHL, UPS) and share the tracking number with us.</p>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />

<p style="font-size:16px"><strong>What happens next</strong></p>

<ul style="margin:8px 0;padding-left:20px">
<li>Once we receive your signed documents, our Certified Acceptance Agent (CAA) will review and certify your passport copy</li>
<li>We will submit the complete ITIN application package to the IRS via certified mail</li>
<li>The IRS typically processes ITIN applications within <strong>7&ndash;11 weeks</strong></li>
<li>You will receive your ITIN number by mail from the IRS, and we will notify you as soon as it is assigned</li>
</ul>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />

<p>If you have any questions, please do not hesitate to contact us.</p>

<p>Best regards,<br/>
<strong>Tony Durante LLC</strong><br/>
<span style="color:#6b7280">+1 (727) 452-1093</span><br/>
<a href="mailto:support@tonydurante.us" style="color:#2563eb">support@tonydurante.us</a></p>

</div>`
}
