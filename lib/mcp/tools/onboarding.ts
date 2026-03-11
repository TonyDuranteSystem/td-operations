/**
 * Onboarding Form Tools — Create, retrieve, and review onboarding data collection forms.
 * For clients with EXISTING LLCs who are onboarding for management services.
 * Follows the same pattern as formation form tools (formation.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createFolder, uploadBinaryToDrive } from "@/lib/google-drive"

export function registerOnboardingTools(server: McpServer) {

  // ═══════════════════════════════════════
  // onboarding_form_create
  // ═══════════════════════════════════════
  server.tool(
    "onboarding_form_create",
    "Create an onboarding data collection form for a client with an existing LLC. Pre-fills owner info from lead. Entity type (SMLLC/MMLLC) and state set as metadata. Returns the form URL (https://td-operations.vercel.app/onboarding-form/{token}). Use email_send to send the link. Unlike formation_form_create, this is for clients who already have an LLC and need management services.",
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
            .select("company_name, state_of_formation, formation_date, ein, entity_type")
            .eq("id", account_id)
            .single()
          if (acct) {
            if (acct.company_name) prefilled.company_name = acct.company_name
            if (acct.state_of_formation) prefilled.state_of_formation = acct.state_of_formation
            if (acct.formation_date) prefilled.formation_date = acct.formation_date
            if (acct.ein) prefilled.ein = acct.ein
          }
        }

        // 5. If contact exists, prefill ITIN
        if (contactId) {
          const { data: ct } = await supabaseAdmin
            .from("contacts")
            .select("itin, itin_issue_date, citizenship, date_of_birth")
            .eq("id", contactId)
            .single()
          if (ct) {
            if (ct.itin) prefilled.owner_itin = ct.itin
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
          .select("id, token, status")
          .eq("token", token)
          .maybeSingle()
        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Onboarding form already exists for ${lead.full_name}\nToken: ${existing.token}\nStatus: ${existing.status}\nURL: https://td-operations.vercel.app/onboarding-form/${existing.token}`,
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
            prefilled_data: prefilled,
            status: "pending",
          })
          .select("id, token")
          .single()
        if (insErr) throw new Error(insErr.message)

        const url = `https://td-operations.vercel.app/onboarding-form/${token}`
        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Onboarding form created for ${lead.full_name}`,
              `   Entity: ${entity_type || "SMLLC"} | State: ${state || "NM"} | Lang: ${formLang}`,
              `   Lead: ${lead.full_name} (${lead.email})`,
              `   Token: ${token}`,
              `   URL: ${url}`,
              `   ID: ${submission.id}`,
              "",
              `Next: Send the URL to the client via email_send`,
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

        lines.push("")
        lines.push(`   URL: https://td-operations.vercel.app/onboarding-form/${data.token}`)
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
          lines.push("APPLYING CHANGES — FULL CRM SETUP")
          lines.push("───────────────────────────────────")
          lines.push("")

          const now = new Date().toISOString()
          const today = now.slice(0, 10)
          const entityTypeMapped = sub.entity_type === "SMLLC" ? "Single Member LLC" : "Multi Member LLC"
          const companyName = String(submitted.company_name || "").trim()
          const stateOfFormation = String(submitted.state_of_formation || sub.state || "").trim()
          let contactId: string | null = sub.contact_id || null
          let accountId: string | null = sub.account_id || null

          // ─── 1. CONTACT: find/create/update ───
          try {
            // Try to find existing contact by ID or email
            if (!contactId && submitted.owner_email) {
              const { data: existingContact } = await supabaseAdmin
                .from("contacts")
                .select("id")
                .eq("email", String(submitted.owner_email))
                .maybeSingle()
              if (existingContact) contactId = existingContact.id
            }

            const ownerFullName = [submitted.owner_first_name, submitted.owner_last_name].filter(Boolean).join(" ").trim()
            const contactFields: Record<string, unknown> = {}
            if (submitted.owner_first_name) contactFields.first_name = submitted.owner_first_name
            if (submitted.owner_last_name) contactFields.last_name = submitted.owner_last_name
            if (ownerFullName) contactFields.full_name = ownerFullName
            if (submitted.owner_email) contactFields.email = submitted.owner_email
            if (submitted.owner_phone) contactFields.phone = submitted.owner_phone
            if (submitted.owner_nationality) contactFields.citizenship = submitted.owner_nationality
            if (submitted.owner_country) contactFields.residency = submitted.owner_country
            if (submitted.owner_dob) contactFields.date_of_birth = submitted.owner_dob
            if (submitted.owner_itin) contactFields.itin_number = submitted.owner_itin
            if (submitted.owner_itin_issue_date) contactFields.itin_issue_date = submitted.owner_itin_issue_date
            contactFields.updated_at = now

            if (contactId) {
              // UPDATE existing contact
              const { error: upErr } = await supabaseAdmin
                .from("contacts")
                .update(contactFields)
                .eq("id", contactId)
              if (upErr) {
                lines.push(`❌ Contact update failed: ${upErr.message}`)
              } else {
                lines.push(`✅ Contact updated (${contactId}): ${Object.keys(contactFields).filter(k => k !== "updated_at").join(", ")}`)
              }
            } else {
              // CREATE new contact
              if (!ownerFullName) throw new Error("Cannot create contact: owner name is empty")
              const { data: newContact, error: createErr } = await supabaseAdmin
                .from("contacts")
                .insert({ ...contactFields, status: "Active" })
                .select("id")
                .single()
              if (createErr || !newContact) {
                lines.push(`❌ Contact creation failed: ${createErr?.message || "unknown error"}`)
              } else {
                contactId = newContact.id
                lines.push(`✅ Contact CREATED (${contactId}): ${ownerFullName}`)
              }
            }
          } catch (e) {
            lines.push(`❌ Contact step failed: ${e instanceof Error ? e.message : String(e)}`)
          }

          // ─── 2. ACCOUNT: find/create/update ───
          try {
            if (!accountId && companyName) {
              const { data: existingAcct } = await supabaseAdmin
                .from("accounts")
                .select("id")
                .ilike("company_name", companyName)
                .maybeSingle()
              if (existingAcct) accountId = existingAcct.id
            }

            const acctFields: Record<string, unknown> = {}
            if (companyName) acctFields.company_name = companyName
            if (submitted.ein) acctFields.ein_number = submitted.ein
            if (stateOfFormation) acctFields.state_of_formation = stateOfFormation
            if (submitted.formation_date) acctFields.formation_date = submitted.formation_date
            if (submitted.filing_id) acctFields.filing_id = submitted.filing_id
            acctFields.entity_type = entityTypeMapped
            acctFields.updated_at = now

            if (accountId) {
              // UPDATE existing account
              const { error: acctErr } = await supabaseAdmin
                .from("accounts")
                .update(acctFields)
                .eq("id", accountId)
              if (acctErr) {
                lines.push(`❌ Account update failed: ${acctErr.message}`)
              } else {
                lines.push(`✅ Account updated (${accountId}): ${Object.keys(acctFields).filter(k => k !== "updated_at").join(", ")}`)
              }
            } else {
              // CREATE new account
              if (!companyName) throw new Error("Cannot create account: company name is empty")
              const { data: newAcct, error: acctCreateErr } = await supabaseAdmin
                .from("accounts")
                .insert({ ...acctFields, status: "Active" })
                .select("id")
                .single()
              if (acctCreateErr || !newAcct) {
                lines.push(`❌ Account creation failed: ${acctCreateErr?.message || "unknown error"}`)
              } else {
                accountId = newAcct.id
                lines.push(`✅ Account CREATED (${accountId}): ${companyName}`)
              }
            }
          } catch (e) {
            lines.push(`❌ Account step failed: ${e instanceof Error ? e.message : String(e)}`)
          }

          // ─── 3. LINK Contact <-> Account ───
          if (contactId && accountId) {
            try {
              const { data: existingLink } = await supabaseAdmin
                .from("account_contacts")
                .select("account_id")
                .eq("account_id", accountId)
                .eq("contact_id", contactId)
                .maybeSingle()
              if (existingLink) {
                lines.push(`✅ Contact-Account link already exists`)
              } else {
                const { error: linkErr } = await supabaseAdmin
                  .from("account_contacts")
                  .insert({ account_id: accountId, contact_id: contactId, role: "Owner" })
                if (linkErr) {
                  lines.push(`❌ Contact-Account link failed: ${linkErr.message}`)
                } else {
                  lines.push(`✅ Contact linked to Account (role: Owner)`)
                }
              }
            } catch (e) {
              lines.push(`❌ Link step failed: ${e instanceof Error ? e.message : String(e)}`)
            }
          }

          // ─── 4. DRIVE FOLDER + DOCUMENT COPY ───
          let driveFolderId: string | null = null
          if (companyName && stateOfFormation) {
            try {
              // Map state name to Drive folder ID (TD Clients / Companies / {State})
              const stateFolderMap: Record<string, string> = {
                "New Mexico": "1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4",
                "NM": "1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4",
                "Wyoming": "110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x",
                "WY": "110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x",
                "Delaware": "1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-",
                "DE": "1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-",
                "Florida": "1XToxqPl-t6z10raeal_frSpvBBBRY8nG",
                "FL": "1XToxqPl-t6z10raeal_frSpvBBBRY8nG",
              }
              const companiesRootId = "1Z32I4pDzX4enwqJQzolbFw7fK94ISuCb"

              const parentFolderId = stateFolderMap[stateOfFormation] || null

              if (!parentFolderId) {
                // State not in map — create under Companies root and warn
                lines.push(`⚠️ State "${stateOfFormation}" not in folder map — creating under Companies root`)
                const newStateFolder = await createFolder(companiesRootId, stateOfFormation) as { id: string; name: string }
                const companyFolder = await createFolder(newStateFolder.id, companyName) as { id: string; name: string }
                driveFolderId = companyFolder.id
                lines.push(`✅ Created Drive folders: Companies/${stateOfFormation}/${companyName}/ (${driveFolderId})`)
              } else {
                const companyFolder = await createFolder(parentFolderId, companyName) as { id: string; name: string }
                driveFolderId = companyFolder.id
                lines.push(`✅ Created Drive folder: Companies/${stateOfFormation}/${companyName}/ (${driveFolderId})`)
              }

              // Set drive_folder_id on account
              if (accountId && driveFolderId) {
                const { error: driveErr } = await supabaseAdmin
                  .from("accounts")
                  .update({ drive_folder_id: driveFolderId })
                  .eq("id", accountId)
                if (driveErr) {
                  lines.push(`❌ Failed to set drive_folder_id: ${driveErr.message}`)
                } else {
                  lines.push(`✅ Account drive_folder_id set to ${driveFolderId}`)
                }
              }

              // Copy uploaded documents from Supabase Storage → Drive
              const uploads = sub.upload_paths as string[] | null
              if (uploads && uploads.length > 0 && driveFolderId) {
                for (const filePath of uploads) {
                  try {
                    const cleanPath = filePath.replace(/^\/+/, "")
                    const { data: blob, error: dlErr } = await supabaseAdmin.storage
                      .from("onboarding-uploads")
                      .download(cleanPath)

                    if (dlErr || !blob) {
                      lines.push(`❌ Download failed (${cleanPath}): ${dlErr?.message || "no data"}`)
                      continue
                    }

                    const arrayBuffer = await blob.arrayBuffer()
                    const fileData = Buffer.from(arrayBuffer)
                    const fileName = cleanPath.split("/").pop() || `file-${Date.now()}`
                    const mimeType = blob.type || "application/pdf"

                    const result = await uploadBinaryToDrive(fileName, fileData, mimeType, driveFolderId) as { id: string; name: string }
                    lines.push(`✅ Copied to Drive: ${result.name} (${result.id})`)
                  } catch (e) {
                    lines.push(`❌ Copy failed (${filePath}): ${e instanceof Error ? e.message : String(e)}`)
                  }
                }
              }
            } catch (e) {
              lines.push(`❌ Drive folder step failed: ${e instanceof Error ? e.message : String(e)}`)
            }
          }

          // ─── 5. CREATE FOLLOW-UP TASKS ───
          if (accountId && companyName) {
            const taskDefs = [
              { title: `Create WhatsApp group — ${companyName}`, assigned_to: "Luca", category: "Client Communication" as const, priority: "High" as const },
              { title: `Prepare and send lease agreement — ${companyName}`, assigned_to: "Antonio", category: "Document" as const, priority: "High" as const },
              { title: `Registered Agent change — ${companyName}`, assigned_to: "Luca", category: "Formation" as const, priority: "High" as const },
            ]
            for (const td of taskDefs) {
              try {
                const { error: taskErr } = await supabaseAdmin
                  .from("tasks")
                  .insert({
                    task_title: td.title,
                    assigned_to: td.assigned_to,
                    category: td.category,
                    priority: td.priority,
                    status: "To Do",
                    account_id: accountId,
                    created_by: "claude",
                  })
                if (taskErr) {
                  lines.push(`❌ Task creation failed (${td.title}): ${taskErr.message}`)
                } else {
                  lines.push(`✅ Task created: "${td.title}" → ${td.assigned_to}`)
                }
              } catch (e) {
                lines.push(`❌ Task creation error (${td.title}): ${e instanceof Error ? e.message : String(e)}`)
              }
            }
          } else {
            lines.push(`⚠️ Skipped task creation: missing account_id or company_name`)
          }

          // ─── 6. CHECK TAX RETURN STATUS ───
          if (accountId && companyName) {
            const returnType = sub.entity_type === "MMLLC" ? "MMLLC" : "SMLLC"
            const currentYear = new Date().getFullYear()
            const previousYear = currentYear - 1

            // SMLLC deadline is April 15, MMLLC is March 15
            const deadlineMonth = returnType === "MMLLC" ? "03" : "04"
            const deadlineDay = "15"

            const taxChecks: Array<{ year: number; field: string; label: string }> = [
              { year: previousYear, field: "tax_return_previous_year_filed", label: "Previous year" },
              { year: currentYear, field: "tax_return_current_year_filed", label: "Current year" },
            ]

            for (const tc of taxChecks) {
              const fieldValue = String(submitted[tc.field] || "").toLowerCase()
              if (fieldValue === "no" || fieldValue === "not sure") {
                try {
                  // Check if tax return already exists
                  const { data: existingTR } = await supabaseAdmin
                    .from("tax_returns")
                    .select("id")
                    .eq("account_id", accountId)
                    .eq("tax_year", tc.year)
                    .maybeSingle()
                  if (existingTR) {
                    lines.push(`✅ Tax return ${tc.year} already exists (${existingTR.id})`)
                  } else {
                    const deadline = `${tc.year + 1}-${deadlineMonth}-${deadlineDay}`
                    const { error: trErr } = await supabaseAdmin
                      .from("tax_returns")
                      .insert({
                        account_id: accountId,
                        company_name: companyName,
                        return_type: returnType,
                        tax_year: tc.year,
                        deadline,
                        status: "Not Invoiced",
                      })
                    if (trErr) {
                      lines.push(`❌ Tax return ${tc.year} creation failed: ${trErr.message}`)
                    } else {
                      lines.push(`✅ Tax return ${tc.year} created (${returnType}, status: Not Invoiced, deadline: ${deadline})`)
                    }
                  }
                } catch (e) {
                  lines.push(`❌ Tax return ${tc.year} error: ${e instanceof Error ? e.message : String(e)}`)
                }
              } else {
                lines.push(`✅ Tax return ${tc.year}: client says "${submitted[tc.field] || "N/A"}" — no action needed`)
              }
            }
          }

          // ─── 7. SET PORTAL FIELDS on account ───
          if (accountId) {
            try {
              const { error: portalErr } = await supabaseAdmin
                .from("accounts")
                .update({ portal_account: true, portal_created_date: today })
                .eq("id", accountId)
              if (portalErr) {
                lines.push(`❌ Portal fields update failed: ${portalErr.message}`)
              } else {
                lines.push(`✅ Account portal_account=true, portal_created_date=${today}`)
              }
            } catch (e) {
              lines.push(`❌ Portal fields error: ${e instanceof Error ? e.message : String(e)}`)
            }
          }

          // ─── 8. MARK LEAD AS CONVERTED ───
          if (sub.lead_id) {
            try {
              const { error: leadErr } = await supabaseAdmin
                .from("leads")
                .update({ status: "Converted", updated_at: now })
                .eq("id", sub.lead_id)
              if (leadErr) {
                lines.push(`❌ Lead update failed: ${leadErr.message}`)
              } else {
                lines.push(`✅ Lead marked as "Converted"`)
              }
            } catch (e) {
              lines.push(`❌ Lead update error: ${e instanceof Error ? e.message : String(e)}`)
            }
          }

          // ─── 9. MARK FORM AS REVIEWED ───
          try {
            const { error: formErr } = await supabaseAdmin
              .from("onboarding_submissions")
              .update({
                status: "reviewed",
                reviewed_at: now,
                reviewed_by: "claude",
              })
              .eq("id", sub.id)
            if (formErr) {
              lines.push(`❌ Form review update failed: ${formErr.message}`)
            } else {
              lines.push(`✅ Form marked as reviewed`)
            }
          } catch (e) {
            lines.push(`❌ Form review error: ${e instanceof Error ? e.message : String(e)}`)
          }

          // ─── 10. UPDATE SUBMISSION with created IDs ───
          try {
            const subUpdates: Record<string, unknown> = { updated_at: now }
            if (accountId && !sub.account_id) subUpdates.account_id = accountId
            if (contactId && !sub.contact_id) subUpdates.contact_id = contactId
            if (Object.keys(subUpdates).length > 1) {
              const { error: subErr } = await supabaseAdmin
                .from("onboarding_submissions")
                .update(subUpdates)
                .eq("id", sub.id)
              if (subErr) {
                lines.push(`❌ Submission ID link failed: ${subErr.message}`)
              } else {
                lines.push(`✅ Submission record updated with account_id/contact_id`)
              }
            }
          } catch (e) {
            lines.push(`❌ Submission update error: ${e instanceof Error ? e.message : String(e)}`)
          }

          // Summary
          lines.push("")
          lines.push("───────────────────────────────────")
          lines.push("SUMMARY")
          lines.push(`   Contact: ${contactId || "FAILED"}`)
          lines.push(`   Account: ${accountId || "FAILED"}`)
          lines.push(`   Company: ${companyName || "(unknown)"}`)
          lines.push(`   Drive folder: ${driveFolderId || "NOT CREATED"}`)
          if (driveFolderId) {
            lines.push(`   Drive link: https://drive.google.com/drive/folders/${driveFolderId}`)
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

} // end registerOnboardingTools
