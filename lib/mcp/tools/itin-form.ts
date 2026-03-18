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
  // itin_form_send
  // ***************************************
  server.tool(
    "itin_form_send",
    `Send the ITIN form link to the client via email with a professional bilingual template. Attaches the passport example image. Updates form status to 'sent'. Requires itin_form_create first. The email explains what the client needs to do, includes the form link, and shows how the passport should look.`,
    {
      token: z.string().describe("ITIN form token"),
    },
    async ({ token }) => {
      try {
        const { data: sub, error } = await supabaseAdmin
          .from("itin_submissions")
          .select("*, access_code")
          .eq("token", token)
          .single()
        if (error || !sub) throw new Error(`Form not found: ${token}`)

        if (sub.status !== "pending" && sub.status !== "sent") {
          return { content: [{ type: "text" as const, text: `⚠️ Form status is "${sub.status}" — expected "pending" or "sent".` }] }
        }

        const prefilled = sub.prefilled_data as Record<string, unknown> || {}
        const clientEmail = String(prefilled.email || "")
        const firstName = String(prefilled.first_name || "")
        if (!clientEmail) {
          return { content: [{ type: "text" as const, text: `❌ No client email found in prefilled data.` }] }
        }

        // Detect language from contact or lead
        let lang: "en" | "it" = "en"
        if (sub.contact_id) {
          const { data: c } = await supabaseAdmin.from("contacts").select("language").eq("id", sub.contact_id).single()
          if (c?.language === "Italian" || c?.language === "it") lang = "it"
        } else if (sub.lead_id) {
          const { data: l } = await supabaseAdmin.from("leads").select("language").eq("id", sub.lead_id).single()
          if (l?.language === "Italian" || l?.language === "it") lang = "it"
        }

        const formUrl = `${APP_BASE_URL}/itin-form/${token}/${sub.access_code || ""}`
        const emailHtml = generateITINFormLinkEmail(firstName, formUrl, lang)
        const subject = lang === "it"
          ? "Richiesta ITIN — Compila il modulo di raccolta dati"
          : "ITIN Application — Please complete the data collection form"

        const { gmailPost } = await import("@/lib/gmail")

        // Simple HTML email — no attachments needed for form link
        const mimeHeaders = [
          `From: Tony Durante LLC <support@tonydurante.us>`,
          `To: ${clientEmail}`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: text/html; charset=utf-8`,
          `Content-Transfer-Encoding: base64`,
        ]
        const rawEmail = [...mimeHeaders, "", Buffer.from(emailHtml).toString("base64")].join("\r\n")
        const encodedRaw = Buffer.from(rawEmail).toString("base64url")
        await gmailPost("/messages/send", { raw: encodedRaw })

        // Update status to sent
        await supabaseAdmin
          .from("itin_submissions")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", sub.id)

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ ITIN form link sent to ${clientEmail}`,
              `   Subject: ${subject}`,
              `   Language: ${lang}`,
              `   Attachments: none (form link only)`,
              `   Form status: sent`,
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
                // Build email body
                const emailBody = `
Dear ${submitted.first_name},

Your ITIN application documents are ready for your signature.

Attached you will find:
1. Form W-7 (Application for IRS Individual Taxpayer Identification Number)
2. Form 1040-NR (U.S. Nonresident Alien Income Tax Return)
3. Schedule OI (Other Information)

INSTRUCTIONS:
1. Print all three documents
2. Sign the W-7 form on the "Signature of applicant" line (wet ink signature required)
3. Sign the 1040-NR on page 2 "Your signature" line (wet ink signature required)
4. Mail all signed documents to:

   Tony Durante LLC
   10225 Ulmerton Rd, Suite 3D
   Largo, FL 33771
   United States

Please use a trackable shipping method (FedEx, DHL, UPS) and share the tracking number with us.

Once we receive your signed documents, we will:
- Review and certify your passport copy (CAA certification)
- Submit the complete ITIN application package to the IRS via certified mail
- The IRS typically processes ITIN applications within 7-11 weeks

If you have any questions, please don't hesitate to contact us.

Best regards,
Tony Durante LLC
+1 (727) 452-1093
support@tonydurante.us
`.trim()

                // Use gmail_send with Drive attachments
                const { gmailPost } = await import("@/lib/gmail")

                // Download PDFs from Drive for attachment
                const { downloadFileBinary } = await import("@/lib/google-drive")
                const { buffer: w7Buf } = await downloadFileBinary(w7FileId)
                const { buffer: nrBuf } = await downloadFileBinary(nrFileId)
                const { buffer: oiBuf } = await downloadFileBinary(oiFileId)

                const boundary = "boundary_" + Date.now()
                const slug2 = clientName.replace(/\s+/g, "_")
                const parts = [
                  `--${boundary}`,
                  `Content-Type: text/plain; charset=utf-8`,
                  `Content-Transfer-Encoding: base64`,
                  "",
                  Buffer.from(emailBody).toString("base64"),
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

// ─── Email Template: ITIN Form Link (sent when form is created) ───

function generateITINFormLinkEmail(firstName: string, formUrl: string, lang: "en" | "it"): string {
  const hr = '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />'
  const btnStyle = 'style="display:inline-block;padding:14px 32px;background:#1e3a5f;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px"'

  if (lang === "it") {
    return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1a1a1a;max-width:640px;margin:0 auto">

<p>Gentile ${firstName},</p>

<p>per procedere con la tua richiesta di <strong>ITIN (Individual Taxpayer Identification Number)</strong>, abbiamo bisogno di alcune informazioni personali.</p>

<p>Clicca il pulsante qui sotto per compilare il modulo:</p>

<p style="text-align:center;margin:24px 0">
<a href="${formUrl}" ${btnStyle}>Compila il Modulo ITIN</a>
</p>

${hr}

<p style="font-size:16px"><strong>Cosa ti chiederemo</strong></p>

<p>Il modulo raccoglie le informazioni necessarie per preparare la tua richiesta ITIN presso l'IRS:</p>

<ol style="margin:8px 0">
<li><strong>Informazioni personali</strong> — nome, data di nascita, cittadinanza, contatti</li>
<li><strong>Indirizzo estero e dati di ingresso</strong> — il tuo indirizzo di residenza, dati del passaporto, eventuale visto USA</li>
<li><strong>Revisione e invio</strong> — verifica i dati inseriti e conferma</li>
</ol>

<p>Una volta ricevuti i tuoi dati, prepareremo i documenti necessari (W-7 e 1040-NR) e ti invieremo una seconda email con tutte le istruzioni per la firma e la spedizione.</p>

${hr}

<p>Per qualsiasi domanda, non esitare a contattarci.</p>

<p>Cordiali saluti,<br/>
<strong>Tony Durante LLC</strong><br/>
<span style="color:#6b7280">+1 (727) 452-1093</span><br/>
<a href="mailto:support@tonydurante.us" style="color:#2563eb">support@tonydurante.us</a></p>

</div>`
  }

  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1a1a1a;max-width:640px;margin:0 auto">

<p>Dear ${firstName},</p>

<p>To proceed with your <strong>ITIN (Individual Taxpayer Identification Number)</strong> application, we need some personal information from you.</p>

<p>Click the button below to complete the form:</p>

<p style="text-align:center;margin:24px 0">
<a href="${formUrl}" ${btnStyle}>Complete ITIN Form</a>
</p>

${hr}

<p style="font-size:16px"><strong>What we will ask</strong></p>

<p>The form collects the information needed to prepare your ITIN application with the IRS:</p>

<ol style="margin:8px 0">
<li><strong>Personal information</strong> — name, date of birth, citizenship, contact details</li>
<li><strong>Foreign address and entry details</strong> — your residential address, passport details, US visa if applicable</li>
<li><strong>Review and submit</strong> — verify all entered data and confirm</li>
</ol>

<p>Once we receive your data, we will prepare the necessary documents (W-7 and 1040-NR) and send you a second email with all instructions for signing and mailing.</p>

${hr}

<p>If you have any questions, please do not hesitate to contact us.</p>

<p>Best regards,<br/>
<strong>Tony Durante LLC</strong><br/>
<span style="color:#6b7280">+1 (727) 452-1093</span><br/>
<a href="mailto:support@tonydurante.us" style="color:#2563eb">support@tonydurante.us</a></p>

</div>`
}

// ─── Email Template: ITIN Signing (sent with W-7 + 1040-NR attached) ───

function generateITINSigningEmail(firstName: string, lang: "en" | "it"): string {
  const hr = '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />'
  const sTd = 'style="padding:10px 12px;background:#f0f5fb;border:1px solid #d1d5db;font-weight:bold;width:32px;text-align:center;color:#1e3a5f"'
  const bTd = 'style="padding:10px 12px;border:1px solid #d1d5db"'
  const alert = 'style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px 20px;margin:16px 0;color:#991b1b"'
  const info = 'style="background:#f0f5fb;border:1px solid #bfdbfe;border-radius:8px;padding:16px 20px;margin:16px 0"'

  if (lang === "it") {
    return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1a1a1a;max-width:640px;margin:0 auto">

<p>Gentile ${firstName},</p>

<p>I documenti per la tua richiesta ITIN sono pronti. In allegato trovi:</p>

<ol style="margin:16px 0">
<li><strong>Form W-7</strong> &mdash; Richiesta di Numero di Identificazione Fiscale Individuale (ITIN)</li>
<li><strong>Form 1040-NR</strong> &mdash; Dichiarazione dei Redditi per Non Residenti USA</li>
<li><strong>Schedule OI</strong> &mdash; Altre Informazioni (allegato al 1040-NR)</li>
</ol>

<div ${alert}>
<strong>IMPORTANTE:</strong> Devi stampare e firmare <strong>DUE copie complete</strong> di ciascun documento. L'IRS ne richiede una per l'elaborazione e una per i nostri archivi come Certified Acceptance Agent.
</div>

${hr}

<p style="font-size:16px"><strong>Cosa devi fare</strong></p>

<table style="border-collapse:collapse;width:100%;margin:12px 0">
<tr><td ${sTd}>1</td><td ${bTd}><strong>Stampa DUE copie</strong> di tutti e tre i documenti (W-7, 1040-NR, Schedule OI)</td></tr>
<tr><td ${sTd}>2</td><td ${bTd}><strong>Firma il W-7</strong> su entrambe le copie, sulla riga <em>"Signature of applicant"</em>.<br/><span style="color:#991b1b">Firma autografa con inchiostro &mdash; le firme digitali o elettroniche NON sono accettate dall'IRS.</span></td></tr>
<tr><td ${sTd}>3</td><td ${bTd}><strong>Firma il 1040-NR</strong> su entrambe le copie, a pagina 2, sulla riga <em>"Your signature"</em> (firma autografa)</td></tr>
<tr><td ${sTd}>4</td><td ${bTd}><strong>Prepara le copie del passaporto</strong> (vedi requisiti sotto)</td></tr>
<tr><td ${sTd}>5</td><td ${bTd}><strong>Spedisci tutto</strong> all'indirizzo indicato sotto</td></tr>
</table>

${hr}

<p style="font-size:16px"><strong>Requisiti per la copia del passaporto</strong></p>

<p>Devi includere <strong>DUE copie a colori chiare e di alta qualita</strong> del tuo passaporto.</p>

<div ${info}>
<p style="margin:0 0 12px 0"><strong>Cosa includere:</strong></p>
<ul style="margin:0;padding-left:20px">
<li><strong>Pagina dei dati</strong> (con foto, nome, data di nascita, numero passaporto e scadenza)</li>
<li><strong>Pagina della firma</strong> (se il tuo passaporto ha una pagina separata per la firma)</li>
</ul>
<p style="margin:16px 0 0 0"><strong>Requisiti di qualita:</strong></p>
<ul style="margin:0;padding-left:20px">
<li><strong>A colori</strong> &mdash; le copie in bianco e nero NON sono accettate</li>
<li><strong>Nitide e chiare</strong> &mdash; testo, foto e elementi di sicurezza completamente leggibili</li>
<li><strong>Scansione piatta</strong> &mdash; niente dita, ombre, riflessi o oggetti</li>
<li><strong>Pagina intera visibile</strong> &mdash; tutti e quattro i bordi visibili</li>
</ul>
</div>

${hr}

<p style="font-size:16px"><strong>Checklist spedizione</strong></p>
<ol style="margin:8px 0">
<li>DUE copie firmate del Form W-7</li>
<li>DUE copie firmate del Form 1040-NR (con Schedule OI allegato)</li>
<li>DUE copie a colori del passaporto (pagina dati + pagina firma)</li>
</ol>

${hr}

<p style="font-size:16px"><strong>Indirizzo di spedizione</strong></p>
<div style="background:#f7f8fa;border:1px solid #d1d5db;border-radius:8px;padding:16px 20px;margin:12px 0">
<strong>Tony Durante LLC</strong><br/>10225 Ulmerton Rd, Suite 3D<br/>Largo, FL 33771<br/>United States
</div>
<p style="color:#b8292f;font-weight:600">Utilizza un metodo di spedizione tracciabile (FedEx, DHL, UPS) e condividi il numero di tracking con noi.</p>

${hr}

<p style="font-size:16px"><strong>Cosa succede dopo</strong></p>
<ol style="margin:8px 0;padding-left:20px">
<li>Il nostro <strong>Certified Acceptance Agent (CAA)</strong> verifichera tutto e certifichera le copie del passaporto</li>
<li>Prepareremo il <strong>Certificate of Accuracy (Form W-7 COA)</strong></li>
<li>Invieremo il pacchetto completo al <strong>Centro di Elaborazione IRS di Austin</strong> tramite posta certificata</li>
<li>L'IRS elabora le richieste ITIN entro <strong>7&ndash;11 settimane</strong></li>
<li>Riceverai il tuo numero ITIN per posta dall'IRS</li>
</ol>

${hr}
<p>Per qualsiasi domanda, non esitare a contattarci.</p>
<p>Cordiali saluti,<br/><strong>Tony Durante LLC</strong><br/><span style="color:#6b7280">Certified Acceptance Agent (CAA) &mdash; IRS ITIN Program</span><br/><span style="color:#6b7280">+1 (727) 452-1093</span><br/><a href="mailto:support@tonydurante.us" style="color:#2563eb">support@tonydurante.us</a></p>
</div>`
  }

  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1a1a1a;max-width:640px;margin:0 auto">

<p>Dear ${firstName},</p>

<p>Your ITIN application documents are ready. Please find attached:</p>

<ol style="margin:16px 0">
<li><strong>Form W-7</strong> &mdash; Application for IRS Individual Taxpayer Identification Number</li>
<li><strong>Form 1040-NR</strong> &mdash; U.S. Nonresident Alien Income Tax Return</li>
<li><strong>Schedule OI</strong> &mdash; Other Information (attached to 1040-NR)</li>
</ol>

<div ${alert}>
<strong>IMPORTANT:</strong> You must print and sign <strong>TWO complete copies</strong> of each document. The IRS requires one copy for processing and one copy for our records as your Certified Acceptance Agent.
</div>

${hr}

<p style="font-size:16px"><strong>What you need to do</strong></p>

<table style="border-collapse:collapse;width:100%;margin:12px 0">
<tr><td ${sTd}>1</td><td ${bTd}><strong>Print TWO copies</strong> of all three documents (W-7, 1040-NR, Schedule OI)</td></tr>
<tr><td ${sTd}>2</td><td ${bTd}><strong>Sign the W-7</strong> on both copies, on the <em>"Signature of applicant"</em> line.<br/><span style="color:#991b1b">Wet ink signature required &mdash; no digital or electronic signatures accepted by the IRS.</span></td></tr>
<tr><td ${sTd}>3</td><td ${bTd}><strong>Sign the 1040-NR</strong> on both copies, on page 2, <em>"Your signature"</em> line (wet ink)</td></tr>
<tr><td ${sTd}>4</td><td ${bTd}><strong>Prepare your passport copies</strong> (see requirements below)</td></tr>
<tr><td ${sTd}>5</td><td ${bTd}><strong>Mail everything</strong> to the address below</td></tr>
</table>

${hr}

<p style="font-size:16px"><strong>Passport Copy Requirements</strong></p>

<p>You must include <strong>TWO clear, high-quality color copies</strong> of your passport.</p>

<div ${info}>
<p style="margin:0 0 12px 0"><strong>What to include:</strong></p>
<ul style="margin:0;padding-left:20px">
<li><strong>Data page</strong> (with photo, name, date of birth, passport number, expiry)</li>
<li><strong>Signature page</strong> (if separate)</li>
</ul>
<p style="margin:16px 0 0 0"><strong>Quality:</strong></p>
<ul style="margin:0;padding-left:20px">
<li><strong>Full color</strong> &mdash; black and white NOT accepted</li>
<li><strong>Clear and sharp</strong> &mdash; all text and security features legible</li>
<li><strong>Flat scan</strong> &mdash; no fingers, shadows, glare, or obstructions</li>
<li><strong>Full page visible</strong> &mdash; all four edges visible</li>
</ul>
</div>

${hr}

<p style="font-size:16px"><strong>Complete mailing checklist</strong></p>
<ol style="margin:8px 0">
<li>TWO signed copies of Form W-7</li>
<li>TWO signed copies of Form 1040-NR (with Schedule OI attached)</li>
<li>TWO clear color copies of your passport (data page + signature page)</li>
</ol>

${hr}

<p style="font-size:16px"><strong>Mailing address</strong></p>
<div style="background:#f7f8fa;border:1px solid #d1d5db;border-radius:8px;padding:16px 20px;margin:12px 0">
<strong>Tony Durante LLC</strong><br/>10225 Ulmerton Rd, Suite 3D<br/>Largo, FL 33771<br/>United States
</div>
<p style="color:#b8292f;font-weight:600">Please use a trackable shipping method (FedEx, DHL, UPS) and share the tracking number with us.</p>

${hr}

<p style="font-size:16px"><strong>What happens next</strong></p>
<ol style="margin:8px 0;padding-left:20px">
<li>Our <strong>Certified Acceptance Agent (CAA)</strong> will review everything and certify your passport copies</li>
<li>We will prepare the <strong>Certificate of Accuracy (Form W-7 COA)</strong></li>
<li>We will submit the complete package to the <strong>IRS Austin Processing Center</strong> via certified mail</li>
<li>The IRS processes ITIN applications within <strong>7&ndash;11 weeks</strong></li>
<li>You will receive your ITIN number by mail from the IRS</li>
</ol>

${hr}
<p>If you have any questions, please do not hesitate to contact us.</p>
<p>Best regards,<br/><strong>Tony Durante LLC</strong><br/><span style="color:#6b7280">Certified Acceptance Agent (CAA) &mdash; IRS ITIN Program</span><br/><span style="color:#6b7280">+1 (727) 452-1093</span><br/><a href="mailto:support@tonydurante.us" style="color:#2563eb">support@tonydurante.us</a></p>
</div>`
}
