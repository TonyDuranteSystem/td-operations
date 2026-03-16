/**
 * Lease Agreement MCP Tools
 *
 * Tools:
 *   lease_create  — Create a lease agreement record for a client
 *   lease_get     — Get full lease details by token or account_id
 *   lease_send    — Approve lease + create Gmail draft to send link
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { safeSend } from "@/lib/mcp/safe-send"

const LEASE_BASE_URL = "https://td-operations.vercel.app/lease"

export function registerLeaseTools(server: McpServer) {

  // ───────────────────────────────────────────────────────────
  // lease_create
  // ───────────────────────────────────────────────────────────
  server.tool(
    "lease_create",
    `Create a new Office Lease Agreement for a client. Pulls tenant info from CRM account + primary contact. Returns the lease URL with access code.

Prerequisites:
- Account must exist with company_name
- Account must have at least one linked contact

Defaults: premises=10225 Ulmerton Rd, Largo FL 33771, monthly_rent=$100, deposit=$150, term=12 months, sq_ft=120.

Suite number format: "3D-XXX" (e.g. 3D-107). REQUIRED — each client gets a unique suite.

The lease is created as 'draft'. Use lease_send to approve and create the Gmail draft.

Admin preview: append ?preview=td to the lease URL (WITHOUT the ?c= access code) to bypass the email gate. Example: https://td-operations.vercel.app/lease/{token}?preview=td. ALWAYS provide the admin preview link after creating a lease so Antonio can review it before sending.

Workflow: lease_create → lease_get (review with admin preview link) → lease_send → client views → signs → PDF saved.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      suite_number: z.string().describe("Suite number assigned to tenant (e.g. '3D-107'). REQUIRED."),
      effective_date: z.string().optional().describe("Effective date YYYY-MM-DD (default: today)"),
      term_start_date: z.string().optional().describe("Lease start date YYYY-MM-DD (default: today)"),
      term_end_date: z.string().optional().describe("Lease end date YYYY-MM-DD (default: December 31 of current year)"),
      contract_year: z.number().optional().describe("Contract year e.g. 2026 (default: current year)"),
      term_months: z.number().optional().describe("Term in months (default: 12)"),
      monthly_rent: z.number().optional().describe("Monthly rent in USD (default: 100)"),
      yearly_rent: z.number().optional().describe("Yearly rent in USD (default: 1200)"),
      security_deposit: z.number().optional().describe("Security deposit in USD (default: 150)"),
      square_feet: z.number().optional().describe("Office square footage (default: 120)"),
      language: z.string().optional().describe("Language: 'en' or 'it' (default: 'en')"),
    },
    async (params) => {
      try {
        // ─── 1. FETCH ACCOUNT ───
        const { data: account, error: accErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, ein_number, state_of_formation")
          .eq("id", params.account_id)
          .single()

        if (accErr || !account) {
          return { content: [{ type: "text" as const, text: `❌ Account not found: ${accErr?.message || "no data"}` }] }
        }

        // ─── 2. FETCH PRIMARY CONTACT ───
        const { data: contactLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("contact_id")
          .eq("account_id", params.account_id)
          .limit(1)

        if (!contactLinks?.length) {
          return { content: [{ type: "text" as const, text: `❌ No contacts linked to account "${account.company_name}". Link a contact first.` }] }
        }

        const { data: contact, error: contactErr } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, email, language")
          .eq("id", contactLinks[0].contact_id)
          .single()

        if (contactErr || !contact) {
          return { content: [{ type: "text" as const, text: `❌ Contact not found: ${contactErr?.message || "no data"}` }] }
        }

        // ─── 3. CHECK DUPLICATE ───
        const year = params.contract_year ?? new Date().getFullYear()
        const { data: existing } = await supabaseAdmin
          .from("lease_agreements")
          .select("id, token, status")
          .eq("account_id", params.account_id)
          .eq("contract_year", year)
          .limit(1)

        if (existing?.length) {
          return { content: [{ type: "text" as const, text: `⚠️ Lease already exists for ${account.company_name} year ${year} (token: ${existing[0].token}, status: ${existing[0].status}). Use lease_get to view it.` }] }
        }

        // ─── 4. BUILD TOKEN ───
        const companySlug = account.company_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
        const token = `${companySlug}-${year}`

        // ─── 5. BUILD DATES ───
        const today = new Date().toISOString().slice(0, 10)
        const effectiveDate = params.effective_date || today
        const termStartDate = params.term_start_date || today
        const termEndDate = params.term_end_date || `${year}-12-31`
        const monthlyRent = params.monthly_rent ?? 100
        const yearlyRent = params.yearly_rent ?? (monthlyRent * 12)

        // ─── 6. INSERT ───
        const { data: lease, error: insertErr } = await supabaseAdmin
          .from("lease_agreements")
          .insert({
            token,
            account_id: params.account_id,
            contact_id: contact.id,
            tenant_company: account.company_name,
            tenant_ein: account.ein_number || null,
            tenant_state: account.state_of_formation || null,
            tenant_contact_name: contact.full_name,
            tenant_email: contact.email || null,
            premises_address: "10225 Ulmerton Rd, Largo, FL 33771",
            suite_number: params.suite_number,
            square_feet: params.square_feet ?? 120,
            effective_date: effectiveDate,
            term_start_date: termStartDate,
            term_end_date: termEndDate,
            term_months: params.term_months ?? 12,
            contract_year: year,
            monthly_rent: monthlyRent,
            yearly_rent: yearlyRent,
            security_deposit: params.security_deposit ?? 150,
            language: params.language || (contact.language?.toLowerCase()?.startsWith('it') ? 'it' : 'en'),
            status: "draft",
          })
          .select("id, token, access_code")
          .single()

        if (insertErr || !lease) {
          return { content: [{ type: "text" as const, text: `❌ Insert failed: ${insertErr?.message || "no data"}` }] }
        }

        const leaseUrl = `${LEASE_BASE_URL}/${lease.token}?c=${lease.access_code}`

        logAction({
          action_type: "create",
          table_name: "lease_agreements",
          record_id: lease.id,
          account_id: params.account_id,
          summary: `Created lease agreement for ${account.company_name} (${year}), Suite ${params.suite_number}`,
          details: { token: lease.token, suite_number: params.suite_number, year },
        })

        const adminPreviewUrl = `${LEASE_BASE_URL}/${lease.token}?preview=td`

        const lines = [
          `✅ Lease Agreement created for **${account.company_name}**`,
          ``,
          `Token: ${lease.token}`,
          `Suite: ${params.suite_number}`,
          `Term: ${fmtDate(termStartDate)} → ${fmtDate(termEndDate)}`,
          `Rent: $${monthlyRent}/month ($${yearlyRent}/year)`,
          `Deposit: $${params.security_deposit ?? 150}`,
          `Status: draft`,
          ``,
          `👁️ Admin Preview: ${adminPreviewUrl}`,
          `🔗 Client URL: ${leaseUrl}`,
          ``,
          `⚠️ Review the admin preview FIRST, then use **lease_send** to send to the client.`,
        ]

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }

      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // lease_get
  // ───────────────────────────────────────────────────────────
  server.tool(
    "lease_get",
    `Get full details of a lease agreement by token (e.g. 'acme-llc-2026') or by account_id + contract_year. Returns all fields including access_code, URL, status, signing info, and linked account/contact names.`,
    {
      token: z.string().optional().describe("Lease token (e.g. 'acme-llc-2026')"),
      account_id: z.string().uuid().optional().describe("Account UUID (use with contract_year)"),
      contract_year: z.number().optional().describe("Contract year (use with account_id)"),
    },
    async (params) => {
      try {
        let query = supabaseAdmin.from("lease_agreements").select("*")

        if (params.token) {
          query = query.eq("token", params.token)
        } else if (params.account_id) {
          query = query.eq("account_id", params.account_id)
          if (params.contract_year) {
            query = query.eq("contract_year", params.contract_year)
          }
          query = query.order("contract_year", { ascending: false }).limit(1)
        } else {
          return { content: [{ type: "text" as const, text: "❌ Provide either token or account_id" }] }
        }

        const { data, error: err } = await query.single()

        if (err || !data) {
          return { content: [{ type: "text" as const, text: `❌ Lease not found: ${err?.message || "no data"}` }] }
        }

        const url = `${LEASE_BASE_URL}/${data.token}?c=${data.access_code}`
        const adminPreviewUrl = `${LEASE_BASE_URL}/${data.token}?preview=td`

        const lines = [
          `📄 **Office Lease Agreement**`,
          ``,
          `Token: ${data.token}`,
          `Status: ${data.status}`,
          `Contract Year: ${data.contract_year}`,
          ``,
          `**Tenant:** ${data.tenant_company}`,
          data.tenant_ein ? `EIN: ${data.tenant_ein}` : null,
          data.tenant_state ? `State: ${data.tenant_state}` : null,
          `Contact: ${data.tenant_contact_name}`,
          data.tenant_email ? `Email: ${data.tenant_email}` : null,
          ``,
          `**Premises:** ${data.premises_address}, Suite ${data.suite_number}`,
          `Square Feet: ${data.square_feet}`,
          ``,
          `**Term:** ${fmtDate(data.term_start_date)} → ${fmtDate(data.term_end_date)} (${data.term_months} months)`,
          `**Rent:** $${data.monthly_rent}/month ($${data.yearly_rent}/year)`,
          `**Deposit:** $${data.security_deposit}`,
          ``,
          `Views: ${data.view_count}${data.viewed_at ? ` (last: ${data.viewed_at})` : ''}`,
          data.signed_at ? `✅ Signed: ${data.signed_at}` : '⏳ Not signed yet',
          data.pdf_storage_path ? `PDF: ${data.pdf_storage_path}` : null,
          ``,
          `👁️ Admin Preview: ${adminPreviewUrl}`,
          `🔗 Client URL: ${url}`,
        ].filter(Boolean)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }

      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // lease_list
  // ───────────────────────────────────────────────────────────
  server.tool(
    "lease_list",
    `List lease agreements with optional filters by status, account, or contract year. Returns token, company, suite, status, term dates, rent, sign status. Use lease_get for full details.`,
    {
      status: z.string().optional().describe("Filter by status: draft, sent, viewed, signed, active, expired"),
      account_id: z.string().uuid().optional().describe("Filter by account UUID"),
      contract_year: z.number().optional().describe("Filter by contract year"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async (params) => {
      try {
        let query = supabaseAdmin
          .from("lease_agreements")
          .select("id, token, account_id, tenant_company, suite_number, status, contract_year, term_start_date, term_end_date, monthly_rent, yearly_rent, view_count, signed_at, created_at")
          .order("created_at", { ascending: false })
          .limit(params.limit ?? 50)

        if (params.status) query = query.eq("status", params.status)
        if (params.account_id) query = query.eq("account_id", params.account_id)
        if (params.contract_year) query = query.eq("contract_year", params.contract_year)

        const { data, error: err } = await query

        if (err) {
          return { content: [{ type: "text" as const, text: `❌ Query error: ${err.message}` }] }
        }

        if (!data?.length) {
          return { content: [{ type: "text" as const, text: "📭 No leases found matching filters." }] }
        }

        const lines = [`Found ${data.length} lease(s)\n`]
        for (const l of data) {
          lines.push(`**${l.tenant_company}** — Suite ${l.suite_number}`)
          lines.push(`  Token: ${l.token} | Year: ${l.contract_year} | Status: ${l.status}`)
          lines.push(`  Term: ${l.term_start_date} → ${l.term_end_date} | Rent: $${l.monthly_rent}/mo`)
          lines.push(`  Views: ${l.view_count}${l.signed_at ? ` | ✅ Signed: ${l.signed_at}` : ' | ⏳ Not signed'}`)
          lines.push(``)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // lease_update
  // ───────────────────────────────────────────────────────────
  server.tool(
    "lease_update",
    `Update fields on an existing lease agreement by token. Only provided fields are changed. Use lease_get first to review current values. Common updates: suite_number, monthly_rent, status, term dates.`,
    {
      token: z.string().describe("Lease token to update"),
      updates: z.record(z.string(), z.any()).describe("Fields to update as key-value pairs (e.g. {suite_number: '3D-108', monthly_rent: 150})"),
    },
    async (params) => {
      try {
        // Fetch current lease
        const { data: existing, error: fetchErr } = await supabaseAdmin
          .from("lease_agreements")
          .select("id, account_id, tenant_company")
          .eq("token", params.token)
          .single()

        if (fetchErr || !existing) {
          return { content: [{ type: "text" as const, text: `❌ Lease not found: ${fetchErr?.message || "no data"}` }] }
        }

        // Apply updates
        const { data, error: updateErr } = await supabaseAdmin
          .from("lease_agreements")
          .update({ ...params.updates, updated_at: new Date().toISOString() })
          .eq("token", params.token)
          .select("token, status, suite_number, monthly_rent, term_start_date, term_end_date")
          .single()

        if (updateErr) {
          return { content: [{ type: "text" as const, text: `❌ Update failed: ${updateErr.message}` }] }
        }

        logAction({
          action_type: "update",
          table_name: "lease_agreements",
          record_id: existing.id,
          account_id: existing.account_id,
          summary: `Updated lease ${params.token}: ${Object.keys(params.updates).join(", ")}`,
          details: params.updates as Record<string, unknown>,
        })

        return { content: [{ type: "text" as const, text: `✅ Lease **${params.token}** updated\n\n${JSON.stringify(data, null, 2)}` }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // lease_send
  // ───────────────────────────────────────────────────────────
  server.tool(
    "lease_send",
    `Approve a lease agreement and send the link to the tenant via Gmail with open tracking. Sets status to 'sent'. Email is sent immediately (NOT a draft). Requires tenant_email to be set on the lease. Use gmail_track_status to check if the client opened the email.`,
    {
      token: z.string().describe("Lease token to send"),
    },
    async (params) => {
      try {
        // Fetch lease
        const { data: lease, error: err } = await supabaseAdmin
          .from("lease_agreements")
          .select("*")
          .eq("token", params.token)
          .single()

        if (err || !lease) {
          return { content: [{ type: "text" as const, text: `❌ Lease not found: ${err?.message || "no data"}` }] }
        }

        if (!lease.tenant_email) {
          return { content: [{ type: "text" as const, text: `❌ No tenant_email set on lease "${params.token}". Update the lease or contact record first.` }] }
        }

        // Build URL
        const url = `${LEASE_BASE_URL}/${lease.token}?c=${lease.access_code}`
        const { gmailPost } = await import("@/lib/gmail")

        const subject = `Office Lease Agreement — ${lease.tenant_company}`
        const fromEmail = "support@tonydurante.us"

        // Generate tracking ID
        const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const pixelUrl = `https://td-operations.vercel.app/api/track/open/${trackingId}`

        // HTML email body
        const htmlBody = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>Dear ${lease.tenant_contact_name},</p>

  <p>Please find your Office Lease Agreement for <strong>${lease.tenant_company}</strong> at the link below.</p>

  <p style="margin: 24px 0;">
    <a href="${url}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">
      Review &amp; Sign Lease Agreement
    </a>
  </p>

  <p>You will be asked to verify your email address (<strong>${lease.tenant_email}</strong>) to access the document.</p>

  <p>The lease covers:</p>
  <ul style="line-height: 1.8;">
    <li><strong>Premises:</strong> 10225 Ulmerton Rd, Suite ${lease.suite_number}, Largo, FL 33771</li>
    <li><strong>Term:</strong> ${fmtDate(lease.term_start_date)} through ${fmtDate(lease.term_end_date)}</li>
    <li><strong>Monthly Rent:</strong> $${lease.monthly_rent}</li>
  </ul>

  <p>If you have any questions, please reply to this email or contact us on WhatsApp.</p>

  <p style="margin-top: 24px;">Best regards,<br/><strong>Tony Durante LLC</strong><br/>support@tonydurante.us</p>
</div>
<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

        const plainText = `Dear ${lease.tenant_contact_name},

Please find your Office Lease Agreement for ${lease.tenant_company} at the link below.

Review and sign the agreement online:
${url}

You will be asked to verify your email address (${lease.tenant_email}) to access the document.

The lease covers:
- Premises: 10225 Ulmerton Rd, Suite ${lease.suite_number}, Largo, FL 33771
- Term: ${fmtDate(lease.term_start_date)} through ${fmtDate(lease.term_end_date)}
- Monthly Rent: $${lease.monthly_rent}

If you have any questions, please reply to this email or contact us on WhatsApp.

Best regards,
Tony Durante LLC
support@tonydurante.us`

        // Build MIME multipart/alternative (text + html)
        const boundary = `boundary_${Date.now()}`

        // RFC 2047: encode subject as base64 if it contains non-ASCII chars (e.g. em dash —)
        const leaseSubject = `Office Lease Agreement — ${lease.tenant_company}`
        const hasNonAscii = /[^\x00-\x7F]/.test(leaseSubject)
        const encodedSubject = hasNonAscii
          ? `=?UTF-8?B?${Buffer.from(leaseSubject, "utf-8").toString("base64")}?=`
          : leaseSubject

        const mimeHeaders = [
          `From: Tony Durante LLC <${fromEmail}>`,
          `To: ${lease.tenant_email}`,
          `Subject: ${encodedSubject}`,
          "MIME-Version: 1.0",
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
        ]

        const mimeParts = [
          mimeHeaders.join("\r\n"),
          "",
          `--${boundary}`,
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(plainText).toString("base64"),
          "",
          `--${boundary}`,
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(htmlBody).toString("base64"),
          "",
          `--${boundary}--`,
        ]

        const encodedRaw = Buffer.from(mimeParts.join("\r\n")).toString("base64url")

        // ─── safeSend: email FIRST, status updates AFTER ───
        const result = await safeSend<{ id: string; threadId: string }>({
          // Idempotency: don't send if already sent
          idempotencyCheck: async () => {
            if (lease.status === "sent") {
              const { data: existing } = await supabaseAdmin
                .from("email_tracking")
                .select("tracking_id, created_at")
                .eq("recipient", lease.tenant_email!)
                .ilike("subject", `%${lease.tenant_company}%`)
                .limit(1)
              if (existing?.length) {
                return {
                  alreadySent: true,
                  message: [
                    `⚠️ Lease email already sent for "${params.token}"`,
                    ``,
                    `Tracking: ${existing[0].tracking_id}`,
                    `Sent at: ${existing[0].created_at}`,
                    ``,
                    `Use gmail_track_status to check if the client opened it.`,
                    `To resend, first use lease_update to set status back to "draft".`,
                  ].join("\n"),
                }
              }
            }
            return null
          },

          // SEND FIRST — actual Gmail send
          sendFn: async () => {
            return await gmailPost("/messages/send", {
              raw: encodedRaw,
            }) as { id: string; threadId: string }
          },

          // POST-SEND: status updates + tracking (only after send succeeds)
          postSendSteps: [
            {
              name: "save_tracking",
              fn: async () => {
                await supabaseAdmin.from("email_tracking").insert({
                  tracking_id: trackingId,
                  gmail_message_id: result.sendResult?.id,
                  gmail_thread_id: result.sendResult?.threadId,
                  recipient: lease.tenant_email,
                  subject,
                  from_email: fromEmail,
                  account_id: lease.account_id || null,
                })
              },
            },
            {
              name: "update_status",
              fn: async () => {
                await supabaseAdmin
                  .from("lease_agreements")
                  .update({ status: "sent", updated_at: new Date().toISOString() })
                  .eq("id", lease.id)
              },
            },
          ],
        })

        // Handle idempotency
        if (result.alreadySent) {
          return { content: [{ type: "text" as const, text: result.idempotencyMessage! }] }
        }

        logAction({
          action_type: "send",
          table_name: "lease_agreements",
          record_id: lease.id,
          account_id: lease.account_id,
          summary: `Sent lease email for ${lease.tenant_company} to ${lease.tenant_email}`,
          details: { token: params.token, gmail_message_id: result.sendResult?.id, tracking_id: trackingId },
        })

        const statusLine = result.hasWarnings
          ? `⚠️ Email sent but some follow-up steps had issues`
          : `✅ Lease email sent via Gmail`

        return { content: [{ type: "text" as const, text: [
          statusLine,
          ``,
          `📧 To: ${lease.tenant_email}`,
          `📋 Subject: ${subject}`,
          `🆔 Message ID: ${result.sendResult?.id}`,
          `👁️ Open tracking: ${trackingId}`,
          ``,
          result.hasWarnings ? `⚠️ Steps: ${result.steps.map(s => `${s.step}=${s.status}`).join(", ")}` : "",
          `Use gmail_track_status to check if the client opened the email.`,
        ].filter(Boolean).join("\n") }] }

      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error sending lease email (lease status NOT changed): ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

} // end registerLeaseTools

// Helper
function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}
