/**
 * Banking Form Tools — Create, retrieve, and review Payset EUR banking application forms.
 * Follows the same pattern as formation form tools (formation.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerBankingFormTools(server: McpServer) {

  // ═══════════════════════════════════════
  // banking_form_create
  // ═══════════════════════════════════════
  server.tool(
    "banking_form_create",
    "Create a banking application form for an existing client. Pre-fills owner info from account + contact. Returns the form URL (https://td-operations.vercel.app/banking-form/{token}). Providers: 'payset' (EUR IBAN, default) or 'relay' (USD business account). Admin preview: append ?preview=td to the form URL to bypass the email gate. ALWAYS provide the admin preview link after creating a form so Antonio can review it before sending. Use gmail_send or email_send to send the link to the client.",
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (auto-detects primary contact if omitted)"),
      language: z.enum(["en", "it"]).optional().describe("Form language (auto-detected from contact.language if omitted)"),
      provider: z.enum(["payset", "relay"]).optional().default("payset").describe("Banking provider: 'payset' (EUR IBAN, default) or 'relay' (USD business account)"),
    },
    async ({ account_id, contact_id, language, provider }) => {
      try {
        // 1. Get account data
        const { data: account, error: acctErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, physical_address, state_of_formation, ein")
          .eq("id", account_id)
          .single()
        if (acctErr || !account) throw new Error(`Account not found: ${acctErr?.message || account_id}`)

        // 2. Resolve contact
        let resolvedContactId = contact_id || null
        if (!resolvedContactId) {
          const { data: ac } = await supabaseAdmin
            .from("account_contacts")
            .select("contact_id")
            .eq("account_id", account_id)
            .limit(1)
            .maybeSingle()
          resolvedContactId = ac?.contact_id || null
        }

        if (!resolvedContactId) throw new Error("No contact found for this account. Provide contact_id explicitly.")

        // 3. Fetch contact
        const { data: contact, error: ctErr } = await supabaseAdmin
          .from("contacts")
          .select("id, first_name, last_name, email, phone, citizenship, residency, language")
          .eq("id", resolvedContactId)
          .single()
        if (ctErr || !contact) throw new Error(`Contact not found: ${ctErr?.message || resolvedContactId}`)

        // 4. Build prefilled data (provider-specific)
        const prefilled: Record<string, unknown> = provider === "relay"
          ? {
              // Relay: business + owner info
              business_name: account.company_name || "",
              phone: contact.phone || "",
              email: contact.email || "",
              ein: account.ein || "",
              first_name: contact.first_name || "",
              last_name: contact.last_name || "",
              personal_phone: contact.phone || "",
              personal_email: contact.email || "",
            }
          : {
              // Payset: personal + business info
              first_name: contact.first_name || "",
              last_name: contact.last_name || "",
              personal_country: contact.citizenship || "",
              business_name: account.company_name || "",
              phone: contact.phone || "",
              email: contact.email || "",
            }

        // 5. Generate token (includes provider prefix for uniqueness)
        const slug = (account.company_name || "form")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 30)
        const year = new Date().getFullYear()
        const providerPrefix = provider === "payset" ? "bank" : provider
        const token = `${providerPrefix}-${slug}-${year}`

        // 6. Check for existing submission
        const { data: existing } = await supabaseAdmin
          .from("banking_submissions")
          .select("id, token, status")
          .eq("token", token)
          .maybeSingle()
        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Form already exists for ${account.company_name}\nToken: ${existing.token}\nStatus: ${existing.status}\nURL: https://td-operations.vercel.app/banking-form/${existing.token}`,
            }],
          }
        }

        // 7. Determine language
        const formLang = language || (contact.language === "Italian" || contact.language === "it" ? "it" : "en")

        // 8. Insert
        const { data: submission, error: insErr } = await supabaseAdmin
          .from("banking_submissions")
          .insert({
            token,
            account_id,
            contact_id: resolvedContactId,
            provider,
            language: formLang,
            prefilled_data: prefilled,
            status: "pending",
          })
          .select("id, token")
          .single()
        if (insErr) throw new Error(insErr.message)

        const url = `https://td-operations.vercel.app/banking-form/${token}`
        const adminPreviewUrl = `${url}?preview=td`
        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Banking form created for ${account.company_name}`,
              `   Provider: ${provider.toUpperCase()} (${provider === "payset" ? "EUR IBAN" : "USD Business"})`,
              `   Contact: ${contact.first_name || ""} ${contact.last_name || ""} (${contact.email || ""})`,
              `   Lang: ${formLang}`,
              `   Token: ${token}`,
              `   ID: ${submission.id}`,
              "",
              `   👁️ Admin Preview: ${adminPreviewUrl}`,
              `   🔗 Client URL: ${url}`,
              "",
              `⚠️ Review the admin preview FIRST, then send the client URL via gmail_send or email_send`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // banking_form_get
  // ═══════════════════════════════════════
  server.tool(
    "banking_form_get",
    "Get a Payset banking application form by token or account_id. Returns prefilled data, submitted data, status, timestamps, and changed fields.",
    {
      token: z.string().optional().describe("Form token (e.g., 'bank-real-alpha-2026')"),
      account_id: z.string().uuid().optional().describe("Account UUID"),
    },
    async ({ token, account_id }) => {
      try {
        let q = supabaseAdmin.from("banking_submissions").select("*")
        if (token) {
          q = q.eq("token", token)
        } else if (account_id) {
          q = q.eq("account_id", account_id)
        } else {
          return { content: [{ type: "text" as const, text: "Provide either token OR account_id." }] }
        }

        const { data, error } = await q.maybeSingle()
        if (error) throw new Error(error.message)
        if (!data) return { content: [{ type: "text" as const, text: "No form found." }] }

        // Get account name
        let accountName = ""
        if (data.account_id) {
          const { data: acct } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", data.account_id)
            .single()
          accountName = acct?.company_name || ""
        }

        const changedCount = data.changed_fields ? Object.keys(data.changed_fields as object).length : 0

        const lines = [
          `📋 Banking Form: ${data.token}`,
          `   Account: ${accountName}`,
          `   Provider: ${(data.provider || "payset").toUpperCase()}`,
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

        const formUrl = `https://td-operations.vercel.app/banking-form/${data.token}`
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
  // banking_form_review
  // ═══════════════════════════════════════
  server.tool(
    "banking_form_review",
    "Review a completed Payset banking form submission. Shows diff table of changed fields (pre-filled vs submitted). If apply_changes=true, updates the Banking Fintech service delivery status and creates a task to schedule the live Payset session. Always run without apply_changes first to review, then confirm with Antonio before applying.",
    {
      token: z.string().describe("Form token to review"),
      apply_changes: z.boolean().optional().default(false).describe("If true, update service delivery + create follow-up task"),
    },
    async ({ token, apply_changes }) => {
      try {
        const { data: sub, error } = await supabaseAdmin
          .from("banking_submissions")
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

        // Get account name
        let accountName = token
        if (sub.account_id) {
          const { data: acct } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", sub.account_id)
            .single()
          accountName = acct?.company_name || token
        }

        const lines = [
          `═══════════════════════════════════════`,
          `  📋 BANKING FORM REVIEW: ${accountName}`,
          `  Provider: ${(sub.provider || "payset").toUpperCase()}`,
          `  Language: ${sub.language}`,
          `═══════════════════════════════════════`,
          "",
        ]

        // Show submitted data summary — Personal info
        lines.push("👤 Personal Info:")
        lines.push(`   Name: ${submitted.first_name || ""} ${submitted.last_name || ""}`)
        lines.push(`   Email: ${submitted.email || ""}`)
        lines.push(`   Phone: ${submitted.phone || ""}`)
        lines.push(`   Country: ${submitted.personal_country || ""}`)
        lines.push("")

        // Show submitted data summary — Business info
        lines.push("🏢 Business Info:")
        lines.push(`   Business Name: ${submitted.business_name || ""}`)
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

          // Update Banking Fintech service if it exists
          const { data: svc } = await supabaseAdmin
            .from("services")
            .select("id, status")
            .eq("account_id", sub.account_id)
            .eq("service_type", "Banking Fintech")
            .maybeSingle()

          if (svc) {
            const { error: svcErr } = await supabaseAdmin
              .from("services")
              .update({
                status: "Data Collected",
                notes: `Banking form completed ${new Date().toISOString()}`,
                updated_at: new Date().toISOString(),
              })
              .eq("id", svc.id)
            if (svcErr) {
              lines.push(`❌ Service update failed: ${svcErr.message}`)
            } else {
              lines.push(`✅ Banking Fintech service updated to "Data Collected"`)
            }
          } else {
            lines.push(`⚠️ No "Banking Fintech" service found for this account — skipping service update`)
          }

          // Get account name for task title
          const { data: acct } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", sub.account_id)
            .single()

          // Create follow-up task (provider-aware)
          const isRelay = (sub.provider || "payset") === "relay"
          const taskTitle = isRelay
            ? `${acct?.company_name || "Client"} — Complete Relay USD account application`
            : `${acct?.company_name || "Client"} — Schedule live Payset application session`
          const taskDesc = isRelay
            ? `Banking form completed. Data collected for Relay USD business account.\n\nNext: Submit the Relay application with the collected data.\n\nForm token: ${token}`
            : `Banking form completed. Data collected for Payset IBAN application.\n\nNext: Schedule a live session via WhatsApp/Telegram to complete the Payset application together with the client (OTP verification required).\n\nForm token: ${token}`

          const { error: taskErr } = await supabaseAdmin
            .from("tasks")
            .insert({
              task_title: taskTitle,
              assigned_to: "Antonio",
              status: "To Do",
              priority: "High",
              category: "Client Communication",
              account_id: sub.account_id,
              description: taskDesc,
              created_by: "Claude",
            })
          if (taskErr) {
            lines.push(`❌ Task creation failed: ${taskErr.message}`)
          } else {
            lines.push(`✅ Task created: "${acct?.company_name || "Client"} — Schedule live Payset application session"`)
          }

          // Mark form as reviewed
          await supabaseAdmin
            .from("banking_submissions")
            .update({
              status: "reviewed",
              reviewed_at: new Date().toISOString(),
              reviewed_by: "claude",
            })
            .eq("id", sub.id)
          lines.push(`✅ Form marked as reviewed`)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

} // end registerBankingFormTools
