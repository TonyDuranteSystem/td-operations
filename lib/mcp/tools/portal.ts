import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { PORTAL_BASE_URL, APP_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"
import { updateAccount } from "@/lib/operations/account"
import { getGmailAttachment } from "@/lib/gmail"
import { formatMcpChatSenderLabel } from "@/lib/portal/chat-sender-name"
import { contactThreadOrFilter, multiMemberAccountIds } from "@/lib/portal/thread-scope"
import { isContactLinkedToAccount, resolveAdminReplyContact } from "@/lib/portal/admin-send-scope"
import { downloadFileBinaryForSend, getFileMetadata } from "@/lib/google-drive"
import { buildChatAttachmentPath } from "@/lib/portal/chat-attachment-path"
import { guessMimeType } from "@/lib/mcp/tools/drive"
import { validateChatAttachment } from "@/lib/portal/chat-attachment"

/**
 * Does this Drive file actually live inside the given account's own Drive
 * folder tree? Walks up to 3 parent-folder levels — the same depth
 * doc_map_folders uses to match orphan documents back to accounts — before
 * giving up. Used by portal_chat_attach_file's 'drive' source so a wrong or
 * copy-pasted file_id can't silently land one client's file in another
 * client's chat thread; account_contacts/contact-only threads have no Drive
 * folder of their own, so this check only applies when account_id is given.
 */
async function driveFileBelongsToAccount(fileId: string, accountId: string): Promise<boolean> {
  const { data: account } = await supabaseAdmin.from("accounts").select("drive_folder_id").eq("id", accountId).maybeSingle()
  const targetFolderId = account?.drive_folder_id as string | null | undefined
  if (!targetFolderId) return false

  let currentFolderId: string | null
  try {
    const meta = (await getFileMetadata(fileId)) as { parents?: string[] }
    currentFolderId = meta.parents?.[0] ?? null
  } catch {
    return false
  }

  for (let level = 0; level < 4 && currentFolderId; level++) {
    if (currentFolderId === targetFolderId) return true
    try {
      const meta = (await getFileMetadata(currentFolderId)) as { parents?: string[] }
      currentFolderId = meta.parents?.[0] ?? null
    } catch {
      return false
    }
  }
  return false
}

// Account fields required for a complete portal experience
const _REQUIRED_ACCOUNT_FIELDS = [
  "ein_number",
  "formation_date",
  "entity_type",
  "state_of_formation",
] as const

export function registerPortalTools(server: McpServer) {

  server.tool(
    "portal_create_user",
    "Create a portal login for a client or partner. Creates a Supabase Auth user with client role, sets temp password, marks account as portal-enabled. Returns login URL + temp password. For LLC clients: pass account_id. For leads without account: pass email + full_name directly. For partners: set portal_role='partner' — auto-sets tier to active, generates referral_code, and sets referrer_type.",
    {
      account_id: z.string().uuid().optional().describe("CRM account UUID (for LLC clients)"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (auto-detects primary contact if omitted)"),
      email: z.string().optional().describe("Email address (for leads without account -- use instead of account_id)"),
      full_name: z.string().optional().describe("Full name (for leads without account)"),
      portal_role: z.enum(["client", "partner"]).optional().default("client").describe("Portal role: 'client' (default) or 'partner' (referrer portal with referral tracking)"),
    },
    async ({ account_id, contact_id, email: directEmail, full_name: directName, portal_role: portalRole }) => {
      try {
        let userEmail = directEmail
        let userName = directName || "Client"

        if (account_id && !directEmail) {
          let targetContactId = contact_id
          if (!targetContactId) {
            const { data: links } = await supabaseAdmin
              .from("account_contacts").select("contact_id").eq("account_id", account_id).limit(1)
            if (!links?.length) return { content: [{ type: "text" as const, text: "No contacts linked to this account" }] }
            targetContactId = links[0].contact_id
          }
          const { data: contactData } = await supabaseAdmin
            .from("contacts").select("full_name, email").eq("id", targetContactId).single()
          if (!contactData?.email) return { content: [{ type: "text" as const, text: "Contact has no email address" }] }
          userEmail = contactData.email
          userName = contactData.full_name
        }

        if (!userEmail) return { content: [{ type: "text" as const, text: "Either account_id or email is required" }] }

        const existingUser = await findAuthUserByEmail(userEmail)
        if (existingUser) return { content: [{ type: "text" as const, text: `Portal user already exists: ${userEmail}` }] }

        const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

        let resolvedContactId = contact_id
        if (!resolvedContactId && account_id) {
          const { data: links } = await supabaseAdmin
            .from("account_contacts").select("contact_id").eq("account_id", account_id).limit(1)
          resolvedContactId = links?.[0]?.contact_id || undefined
        }

        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
          email: userEmail, password: tempPassword, email_confirm: true,
          app_metadata: { role: "client", ...(resolvedContactId ? { contact_id: resolvedContactId } : {}) },
          user_metadata: { full_name: userName, must_change_password: true },
        })

        if (createError) return { content: [{ type: "text" as const, text: createError.message }] }

        let portalTier = "lead"
        if (account_id) {
          // Check account type — One-Time customers with paid deals go straight to active
          const { data: acctData } = await supabaseAdmin.from("accounts").select("account_type").eq("id", account_id).single()
          if (acctData?.account_type === "One-Time") {
            portalTier = "active"
          } else {
            const { data: offers } = await supabaseAdmin.from("offers").select("status, contract_type")
              .eq("account_id", account_id).in("status", ["completed", "signed"]).limit(1)
            if (offers?.length) {
              portalTier = offers[0].contract_type === "formation" ? "formation" : "onboarding"
            }
          }

          if (portalTier === "lead") {
            const { data: existingSds } = await supabaseAdmin.from("service_deliveries").select("id").eq("account_id", account_id).limit(1)
            const { data: ss4s } = await supabaseAdmin.from("ss4_applications").select("id").eq("account_id", account_id).limit(1)
            if (existingSds?.length || ss4s?.length) portalTier = "active"
          }

          await updateAccount({
            id: account_id,
            patch: {
              portal_account: true,
              portal_tier: portalTier,
              portal_created_date: new Date().toISOString().split("T")[0],
            },
            actor: "claude.ai",
            summary: `Portal user created (tier=${portalTier})`,
          })
        }

        if (resolvedContactId) {
          const contactUpdates: Record<string, unknown> = { portal_tier: portalTier }

          // Partner-specific setup
          if (portalRole === "partner") {
            contactUpdates.portal_role = "partner"
            contactUpdates.portal_tier = "active" // Partners always get active tier
            contactUpdates.referrer_type = "partner"
            portalTier = "active"
          }

          // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
          await supabaseAdmin.from("contacts").update(contactUpdates).eq("id", resolvedContactId)

          // Generate referral code for partners
          let referralCode: string | undefined
          if (portalRole === "partner") {
            const { generateReferralCode } = await import("@/lib/referral-utils")
            referralCode = await generateReferralCode(userName, supabaseAdmin)
            // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
            await supabaseAdmin.from("contacts").update({ referral_code: referralCode }).eq("id", resolvedContactId)
          }
        }

        // For partner referral code in response message
        let referralCode: string | undefined
        if (portalRole === "partner" && resolvedContactId) {
          const { data: codeData } = await supabaseAdmin.from("contacts").select("referral_code").eq("id", resolvedContactId).single()
          referralCode = codeData?.referral_code || undefined
        }

        logAction({
          action_type: "create", table_name: "auth.users",
          record_id: newUser.user.id, account_id: account_id || undefined,
          summary: `Portal user created: ${userName} (${userEmail})${portalRole === "partner" ? " [PARTNER]" : ""}. IMPORTANT: Credentials email NOT sent yet -- send via gmail_send then update contacts.portal_email_sent_at.`,
        })

        const lines = [
          `Portal account created${portalRole === "partner" ? " (Partner)" : ""}`,
          `${userName} (${userEmail})`,
          `Temp password: ${tempPassword}`,
          `Login: ${PORTAL_BASE_URL}/portal/login`,
        ]
        if (referralCode) {
          lines.push(``, `Referral code: ${referralCode}`, `Referral link: ${APP_BASE_URL}/r/${referralCode}`)
        }
        lines.push(
          ``,
          `${portalRole === "partner" ? "Partner" : "Client"} will be asked to change password on first login.`,
          ``,
          `IMPORTANT: Credentials email has NOT been sent yet.`,
          `After sending the email with gmail_send, you MUST update the contact:`,
          `crm_update_record(contacts, ${resolvedContactId || '<contact_id>'}, {portal_email_sent_at: '${new Date().toISOString().split("T")[0]}', portal_email_template: '<template_name>'})`,
        )

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_invoice_create ───────────────────────────────────────────

  server.tool(
    "portal_invoice_create",
    `Create a TD LLC invoice TO a client (writes to payments + client_expenses). The OFFICIAL invoicing system — use this instead of QB for new invoices.

Supports two scenarios:
- **Contact-level** (pass contact_id): For setup fees, ITIN, or any payment before an account exists. The contact is the center — they pay before any LLC is created.
- **Account-level** (pass account_id): For annual installments, recurring services on an existing LLC.
- Both can be provided (contact pays for a specific company).

Returns the created invoice with payment ID, number, total. The client sees this as an expense in their portal.

Workflow: portal_invoice_create -> portal_invoice_send (email with PDF) -> client pays -> mark as paid.
Or: portal_invoice_create(mark_as_paid=true) if already paid (invoices are receipts per rule P6).`,
    {
      contact_id: z.string().uuid().optional().describe("Contact UUID — invoice a person (setup fees, pre-account). At least one of contact_id or account_id required."),
      account_id: z.string().uuid().optional().describe("Account UUID — invoice a company (annual installments). At least one of contact_id or account_id required."),
      line_items: z.array(z.object({
        description: z.string().describe("Line item description"),
        unit_price: z.number().describe("Unit price"),
        quantity: z.number().optional().describe("Quantity (default 1)"),
      })).min(1).describe("Invoice line items"),
      currency: z.enum(["USD", "EUR"]).optional().describe("Currency (default USD)"),
      due_date: z.string().optional().describe("Due date YYYY-MM-DD"),
      notes: z.string().optional().describe("Private notes (not visible to client)"),
      message: z.string().optional().describe("Payment terms visible to customer on invoice"),
      mark_as_paid: z.boolean().optional().describe("If true, create as Paid with today's date (invoices are receipts per rule P6)"),
      paid_date: z.string().optional().describe("Override paid date (YYYY-MM-DD) if different from today"),
      installment: z.enum(["Setup Fee", "Installment 1 (Jan)", "Installment 2 (Jun)", "Annual Payment", "One-Time Service", "Custom"]).optional().describe("Set this for an annual installment invoice — required for the account-page badge and the duplicate-invoice warning to see it. Omit for setup fees / one-off invoices."),
      year: z.number().optional().describe("Billing year this invoice is FOR (not necessarily the year it's created in). Required alongside installment='Installment 1 (Jan)'/'Installment 2 (Jun)' for the duplicate-invoice warning to check this account."),
    },
    async ({ contact_id, account_id, line_items, currency, due_date, notes, message, mark_as_paid, paid_date, installment, year }) => {
      try {
        if (!contact_id && !account_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of contact_id or account_id is required. Contact = person (pre-account). Account = company." }] }
        }

        const cur = currency || "USD"

        // Resolve customer info for display
        let customerName = ""
        let resolvedContactId = contact_id
        const resolvedAccountId = account_id

        if (contact_id) {
          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("full_name, email")
            .eq("id", contact_id)
            .single()
          if (!contact) return { content: [{ type: "text" as const, text: `Contact ${contact_id} not found` }] }
          customerName = contact.full_name
        }

        if (account_id) {
          const { data: account } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", account_id)
            .single()
          if (!account) return { content: [{ type: "text" as const, text: `Account ${account_id} not found` }] }

          if (!contact_id) {
            const { data: link } = await supabaseAdmin
              .from("account_contacts")
              .select("contact_id, contacts(full_name)")
              .eq("account_id", account_id)
              .limit(1)
              .single()
            if (link) {
              resolvedContactId = link.contact_id
              const c = link.contacts as unknown as { full_name: string }
              if (!customerName) customerName = c.full_name
            }
          }

          customerName = account.company_name
        }

        if (!customerName) {
          return { content: [{ type: "text" as const, text: "Could not resolve customer name from contact or account" }] }
        }

        // Create TD invoice (writes to payments + client_expenses, NOT client_invoices)
        const { createTDInvoice } = await import("@/lib/portal/td-invoice")
        let result: Awaited<ReturnType<typeof createTDInvoice>>
        try {
          result = await createTDInvoice({
            account_id: resolvedAccountId || undefined,
            contact_id: resolvedContactId || undefined,
            line_items,
            currency: cur as 'USD' | 'EUR',
            due_date: due_date || undefined,
            notes: notes || undefined,
            message: message || undefined,
            mark_as_paid: mark_as_paid || false,
            paid_date: paid_date || undefined,
            installment: installment || undefined,
            year: year || undefined,
          })
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Failed to create invoice: ${err instanceof Error ? err.message : String(err)}` }] }
        }

        const { paymentId, invoiceNumber, total, status } = result

        // Auto-create Whop checkout plan for card payment (+5%)
        let whopUrl: string | null = null
        try {
          const whopKey = process.env.WHOP_API_KEY
          if (whopKey && !mark_as_paid) {
            const cardAmount = Math.ceil(total * 1.05)
            const firstItem = line_items[0]?.description || "Invoice"
            const planTitle = `${firstItem} - ${customerName}`.substring(0, 80)

            const prodRes = await fetch("https://api.whop.com/api/v1/products?company_id=biz_rssyD9YyMnXd7P&first=50", {
              headers: { Authorization: `Bearer ${whopKey}`, "Content-Type": "application/json" },
            })
            const prodData = await prodRes.json()
            const products = prodData.data || []
            const defaultProduct = products.find((p: { title: string }) => p.title?.includes("Onboarding")) || products[0]

            if (defaultProduct) {
              const planRes = await fetch("https://api.whop.com/api/v1/plans", {
                method: "POST",
                headers: { Authorization: `Bearer ${whopKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  company_id: "biz_rssyD9YyMnXd7P",
                  product_id: defaultProduct.id,
                  title: planTitle,
                  initial_price: cardAmount,
                  currency: cur.toLowerCase(),
                  plan_type: "one_time",
                  release_method: "buy_now",
                  visibility: "visible",
                  unlimited_stock: true,
                }),
              })
              if (planRes.ok) {
                const plan = await planRes.json()
                whopUrl = plan.purchase_url || `https://whop.com/checkout/${plan.id}`

                // Store on payments record (not client_invoices)
                // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
                await supabaseAdmin
                  .from("payments")
                  .update({ whop_payment_id: plan.id })
                  .eq("id", paymentId)
              }
            }
          }
        } catch {
          // Whop plan creation failed — invoice still works, just no card option
        }

        await logAction({
          action_type: "create",
          table_name: "payments",
          record_id: paymentId,
          account_id: resolvedAccountId || undefined,
          summary: `TD invoice ${invoiceNumber} created: ${cur} ${total.toFixed(2)} (${status})${whopUrl ? " + Whop checkout" : ""}`,
        })

        // Notify client about new invoice
        if (!mark_as_paid && (resolvedAccountId || resolvedContactId)) {
          const { createPortalNotification } = await import("@/lib/portal/notifications")
          await createPortalNotification({
            account_id: resolvedAccountId || undefined,
            contact_id: resolvedContactId || undefined,
            type: "invoice",
            title: `New invoice ${invoiceNumber}`,
            body: `${cur === "EUR" ? "EUR" : "$"}${total.toFixed(2)}`,
            link: "/portal/invoices?tab=expenses",
          }).catch(() => {})
        }

        const csym = cur === "EUR" ? "EUR" : "$"
        const cardAmount = Math.ceil(total * 1.05)
        return {
          content: [{
            type: "text" as const,
            text: [
              `Invoice created:`,
              `- Invoice: ${invoiceNumber}`,
              `- Customer: ${customerName}`,
              `- Total: ${csym}${total.toFixed(2)}`,
              `- Status: ${status}`,
              `- Payment ID: ${paymentId}`,
              resolvedContactId ? `- Contact: ${resolvedContactId}` : "",
              resolvedAccountId ? `- Account: ${resolvedAccountId}` : "",
              whopUrl ? `- Card payment: ${whopUrl} (${csym}${cardAmount} with 5% fee)` : "",
              result.duplicate_warning ? `\n⚠ ${result.duplicate_warning}` : "",
              ``,
              mark_as_paid ? "Marked as paid." : "Use portal_invoice_send to email the invoice to the client.",
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_invoice_send ─────────────────────────────────────────────

  server.tool(
    "portal_invoice_send",
    `Send a portal invoice via email with PDF attachment. Marks the invoice as 'Sent'. Email is sent with the client's company name as sender and Reply-To set to the client's email so any replies go directly to them. The email includes invoice details, bank payment instructions, and a Pay Now button if a payment link exists.

Prerequisite: Invoice must exist (created via portal_invoice_create or portal dashboard).`,
    {
      invoice_id: z.string().uuid().describe("Portal invoice UUID (from portal_invoice_create)"),
      email_to: z.string().optional().describe("Override recipient email (default: customer email from invoice)"),
      language: z.enum(["en", "it"]).optional().describe("Email language (default: en)"),
    },
    async ({ invoice_id, email_to, language }) => {
      try {
        const lang = language || "en"

        // Fetch invoice with items
        const { data: invoice } = await supabaseAdmin
          .from("client_invoices")
          .select("*")
          .eq("id", invoice_id)
          .single()

        if (!invoice) return { content: [{ type: "text" as const, text: `Invoice ${invoice_id} not found` }] }

        if (invoice.status === "Sent" || invoice.status === "Paid") {
          return { content: [{ type: "text" as const, text: `Invoice ${invoice.invoice_number} is already ${invoice.status}. Cannot re-send.` }] }
        }

        // Get customer
        const { data: customer } = await supabaseAdmin
          .from("client_customers")
          .select("name, email")
          .eq("id", invoice.customer_id)
          .single()

        const recipientEmail = email_to || customer?.email
        if (!recipientEmail) return { content: [{ type: "text" as const, text: "No recipient email. Provide email_to or ensure customer has email." }] }

        // Get account company name and reply-to email
        const { data: invoiceAccount } = await supabaseAdmin
          .from("accounts")
          .select("company_name")
          .eq("id", invoice.account_id)
          .single()
        const companyName = invoiceAccount?.company_name || "Our Company"

        const { getCompanyEmail } = await import("@/lib/portal/queries")
        const replyTo = invoice.account_id ? await getCompanyEmail(invoice.account_id) : null

        const csym = invoice.currency === "EUR" ? "EUR " : "$"
        const customerName = customer?.name || "Client"
        const greeting = lang === "it" ? `Gentile ${customerName}` : `Dear ${customerName}`
        const subject = `Invoice ${invoice.invoice_number} from ${companyName}`

        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #2563eb; padding: 24px; border-radius: 12px 12px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 20px;">${companyName}</h1>
            </div>
            <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
              <p>${greeting},</p>
              <p>${lang === "it" ? "In allegato la fattura" : "Please find attached invoice"} <strong>${invoice.invoice_number}</strong>.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr style="background: #f8fafc;"><td style="padding: 8px 12px; font-weight: bold; color: #6b7280;">Invoice</td><td style="padding: 8px 12px;">${invoice.invoice_number}</td></tr>
                <tr><td style="padding: 8px 12px; font-weight: bold; color: #6b7280;">Date</td><td style="padding: 8px 12px;">${invoice.issue_date}</td></tr>
                ${invoice.due_date ? `<tr style="background: #f8fafc;"><td style="padding: 8px 12px; font-weight: bold; color: #6b7280;">Due</td><td style="padding: 8px 12px;">${invoice.due_date}</td></tr>` : ""}
                <tr><td style="padding: 8px 12px; font-weight: bold; color: #6b7280;">Total</td><td style="padding: 8px 12px; font-size: 18px; font-weight: bold; color: #2563eb;">${csym}${(invoice.total ?? 0).toFixed(2)}</td></tr>
              </table>
              ${invoice.message ? `<div style="background: #f8fafc; padding: 16px; border-radius: 8px;"><p style="margin: 0; font-size: 14px; white-space: pre-wrap;">${invoice.message}</p></div>` : ""}
              <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">${lang === "it" ? "Per domande, rispondi a questa email." : "If you have questions, reply to this email."}</p>
            </div>
          </div>
        `

        // Generate tracking ID and inject pixel
        const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`
        const trackedHtml = html + `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

        // Send via Gmail
        const { gmailPost } = await import("@/lib/gmail")
        const boundary = `boundary_${Date.now()}`
        const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
        const parts = [
          `From: ${companyName} <support@tonydurante.us>`,
          `To: ${recipientEmail}`,
          ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
          `Subject: ${encodedSubject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          "",
          `--${boundary}`,
          "Content-Type: text/html; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(trackedHtml).toString("base64"),
          `--${boundary}--`,
        ]
        const raw = Buffer.from(parts.join("\r\n")).toString("base64url")
        const sendResult = await gmailPost("/messages/send", { raw }) as { id?: string; threadId?: string }

        // Store email tracking record
        await supabaseAdmin.from("email_tracking").insert({
          tracking_id: trackingId,
          gmail_message_id: sendResult?.id || null,
          gmail_thread_id: sendResult?.threadId || null,
          recipient: recipientEmail,
          subject,
          from_email: "support@tonydurante.us",
          account_id: invoice.account_id || null,
          contact_id: invoice.contact_id || null,
        })

        // Mark as Sent
        await supabaseAdmin
          .from("client_invoices")
          .update({ status: "Sent", updated_at: new Date().toISOString() })
          .eq("id", invoice_id)

        await logAction({
          action_type: "update",
          table_name: "client_invoices",
          record_id: invoice_id,
          account_id: invoice.account_id || undefined,
          summary: `Portal invoice ${invoice.invoice_number} sent to ${recipientEmail}`,
        })

        return {
          content: [{
            type: "text" as const,
            text: `Invoice ${invoice.invoice_number} sent to ${recipientEmail}. Status updated to Sent.`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_inbox ───────────────────────────────────────────────

  server.tool(
    "portal_chat_inbox",
    `PREFERRED tool for checking client messages. Shows all portal chat threads with unread counts, last message preview, and client names.

When Antonio says "read the message", "check messages", "any messages?", "vedi messaggi", or similar → use THIS tool FIRST. Do NOT use msg_inbox (that is legacy WhatsApp/Telegram only).

Returns threads sorted by most recent message. Each thread shows:
- Client name (company or contact)
- Last message preview and timestamp
- Unread count (client messages not yet read by admin)
- account_id and/or contact_id for follow-up with portal_chat_read

Supports filtering:
- No args: all threads with any messages
- unread_only=true: only threads with unread client messages
- account_id: specific company thread
- contact_id: specific person's threads (across all their LLCs + contact-only)`,
    {
      unread_only: z.boolean().optional().default(false).describe("Only show threads with unread client messages"),
      account_id: z.string().uuid().optional().describe("Filter to a specific account/LLC"),
      contact_id: z.string().uuid().optional().describe("Filter to a specific contact/person — shows ALL their threads (account + contact-only)"),
      limit: z.number().optional().default(20).describe("Max threads to return (default 20)"),
    },
    async ({ unread_only, account_id, contact_id, limit }) => {
      try {
        // Same source of truth as the CRM Portal Chats inbox (2026-07-08):
        // get_portal_chat_threads_v2 applies the "one message, one staff
        // thread" rule (multi-member accounts get ONE account-level thread;
        // person threads carry only personal + solo-company messages). The
        // tool previously hand-rolled its own thread list, which double-showed
        // MMLLC messages as both a company and a person thread.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: rows, error } = await (supabaseAdmin as any).rpc("get_portal_chat_threads_v2")
        if (error) {
          return { content: [{ type: "text" as const, text: `Failed to load threads: ${error.message}` }] }
        }

        type ThreadRow = {
          contact_id: string | null
          contact_name: string
          account_id: string | null
          companies: { id: string; name: string }[]
          members: { id: string; name: string }[]
          last_message: string | null
          last_message_at: string | null
          unread_count: number
        }
        let threads = (rows ?? []) as ThreadRow[]

        if (account_id) {
          // Multi-member account → its own account-level thread. Solo account →
          // its messages live in the owner's person thread (companies pill).
          threads = threads.filter(t =>
            t.account_id === account_id || (t.companies ?? []).some(c => c.id === account_id)
          )
        } else if (contact_id) {
          // The person's own thread + every account-level thread they're a member of.
          threads = threads.filter(t =>
            t.contact_id === contact_id || (t.members ?? []).some(m => m.id === contact_id)
          )
        }
        if (unread_only) threads = threads.filter(t => Number(t.unread_count) > 0)
        threads = threads.slice(0, limit)

        if (threads.length === 0) {
          return { content: [{ type: "text" as const, text: unread_only ? "No unread portal messages." : "No portal chat threads found." }] }
        }

        const totalUnread = threads.reduce((sum, t) => sum + Number(t.unread_count), 0)
        const lines = threads.map(t => {
          const unread = Number(t.unread_count)
          const unreadBadge = unread > 0 ? ` [${unread} unread]` : ""
          // Account thread → company (member names); person thread → person (company names)
          const detail = t.account_id
            ? (t.members ?? []).map(m => m.name).join(", ")
            : (t.companies ?? []).map(c => c.name).join(", ")
          const name = detail ? `${t.contact_name} (${detail})` : t.contact_name
          const time = t.last_message_at ? new Date(t.last_message_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""
          const id = t.account_id ? `account_id: ${t.account_id}` : `contact_id: ${t.contact_id}`
          const preview = (t.last_message ?? "").substring(0, 100)
          return `${unread > 0 ? "🔴" : "⚪"} **${name}**${unreadBadge}\n   Last (${time}): "${preview}${(t.last_message ?? "").length > 100 ? "..." : ""}"\n   ${id}`
        })

        return {
          content: [{
            type: "text" as const,
            text: `Portal Chat Inbox — ${totalUnread} unread message${totalUnread !== 1 ? "s" : ""} across ${threads.filter(t => Number(t.unread_count) > 0).length} thread${threads.filter(t => Number(t.unread_count) > 0).length !== 1 ? "s" : ""}\n\n${lines.join("\n\n")}\n\nUse portal_chat_read(account_id or contact_id) to read full conversation.`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `❌ portal_chat_inbox error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_read ──────────────────────────────────────────────

  server.tool(
    "portal_chat_read",
    `Read the full message history for a portal chat thread. Returns messages in chronological order with sender info, timestamps, and attachments.

Use after portal_chat_inbox to read a specific conversation. Pass either account_id (for LLC threads) or contact_id (for person threads: the contact's personal messages plus their solo-owned companies' messages; multi-member LLC messages live in their own account thread).

After reading, you should:
1. Summarize what the client said
2. Load their context via crm_get_client_summary if needed
3. Propose a response or action
4. Show the draft to Antonio for approval BEFORE sending via portal_chat_send

Does NOT auto-mark messages as read. Use portal_chat_mark_read explicitly after Antonio has seen the summary.`,
    {
      account_id: z.string().uuid().optional().describe("Account UUID — read LLC thread. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID — read person thread (contact-only, no LLC). At least one of account_id or contact_id required."),
      limit: z.number().optional().default(30).describe("Number of messages to return (default 30, most recent)"),
    },
    async ({ account_id, contact_id, limit: msgLimit }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of account_id or contact_id is required." }] }
        }

        // Get thread context (client name)
        let clientName = "Unknown"
        if (account_id) {
          const { data: acct } = await supabaseAdmin.from("accounts").select("company_name").eq("id", account_id).single()
          clientName = acct?.company_name ?? account_id
        } else if (contact_id) {
          const { data: ct } = await supabaseAdmin.from("contacts").select("full_name, email").eq("id", contact_id).single()
          clientName = ct?.full_name ?? ct?.email ?? contact_id
        }

        // Fetch messages
        let query = supabaseAdmin
          .from("portal_messages")
          .select("id, sender_type, sender_id, message, attachment_url, attachment_name, attachments, read_at, created_at, deleted_at, contact_id, contacts:contact_id(full_name)")
          .order("created_at", { ascending: false })
          .limit(msgLimit)

        if (account_id) {
          query = query.eq("account_id", account_id)
        } else {
          // Person thread = personal messages + solo-company messages, same
          // scope as the CRM inbox (multi-member accounts' messages live in
          // their own account thread — "one message, one staff thread",
          // 2026-07-08, shared rule in lib/portal/thread-scope.ts).
          const { data: links } = await supabaseAdmin
            .from("account_contacts")
            .select("account_id")
            .eq("contact_id", contact_id!)
          const linked = (links ?? []).map(l => l.account_id as string)
          const excluded = await multiMemberAccountIds(linked)
          query = query.or(contactThreadOrFilter(contact_id!, linked, excluded))
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: messages, error } = await (query as any)
        if (error) return { content: [{ type: "text" as const, text: `Failed to read messages: ${error.message}` }] }
        if (!messages?.length) return { content: [{ type: "text" as const, text: `No messages found for ${clientName}.` }] }

        // Reverse to chronological order
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sorted = (messages as any[]).reverse()

        // Count unread
        const unreadCount = sorted.filter(m => m.sender_type === "client" && !m.read_at).length

        // Format messages
        const formatted = sorted.map(m => {
          const contactData = (m as any).contacts as { full_name: string } | null
          // Staff (admin/system) messages are labelled "TD Team" — never a contact
          // name. The row's contact_id on an admin send is a routing tag (an
          // arbitrary linked member), NOT the author. See staffChatSenderLabel.
          const sender = formatMcpChatSenderLabel(m.sender_type, contactData?.full_name)
          const time = new Date(m.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
          // R100 tombstone — this tool is staff-only (never client-reachable),
          // so a deleted row stays listed but its body is replaced, matching
          // the dashboard's own admin view (portal-chats/page.tsx).
          if ((m as any).deleted_at) {
            const deletedTime = new Date((m as any).deleted_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
            return `[${time}] ${sender}:\n   [Deleted ${deletedTime} · originally sent ${time}]`
          }
          const readStatus = m.sender_type === "client" && !m.read_at ? " 🔴 UNREAD" : ""
          const atts = (m as any).attachments?.length
            ? (m as any).attachments.map((a: { name: string; url: string }) => `\n   📎 ${a.name} — ${a.url}`).join("")
            : m.attachment_url ? `\n   📎 ${m.attachment_name || "file"} — ${m.attachment_url}` : ""
          return `[${time}] ${sender}${readStatus}:\n   ${m.message}${atts}`
        })

        return {
          content: [{
            type: "text" as const,
            text: `Portal Chat — ${clientName} (${unreadCount} unread)\n${"─".repeat(50)}\n\n${formatted.join("\n\n")}\n\n${"─".repeat(50)}\nMessages shown: ${sorted.length}. ${unreadCount > 0 ? "Use portal_chat_mark_read to mark as read after review." : "All messages read."}`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `❌ portal_chat_read error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_mark_read ────────────────────────────────────────────

  server.tool(
    "portal_chat_mark_read",
    `Mark client messages as read in a portal chat thread. Call this AFTER Antonio has reviewed the messages (via portal_chat_read summary), NOT automatically.

This updates read_at on unread client messages, which:
- Clears the unread badge in the CRM dashboard
- Signals to other team members that messages have been handled

Only marks client→admin messages as read (admin messages don't need read tracking).`,
    {
      account_id: z.string().uuid().optional().describe("Account UUID — mark LLC thread as read. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID — mark person thread as read. At least one of account_id or contact_id required."),
    },
    async ({ account_id, contact_id }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of account_id or contact_id is required." }] }
        }

        // First count unread messages
        let countQuery = supabaseAdmin
          .from("portal_messages")
          .select("id", { count: "exact", head: true })
          .eq("sender_type", "client")
          .is("read_at", null)

        if (account_id) {
          countQuery = countQuery.eq("account_id", account_id)
        } else {
          countQuery = countQuery.eq("contact_id", contact_id!).is("account_id", null)
        }

        const { count } = await countQuery

        // Then update them
        let updateQuery = supabaseAdmin
          .from("portal_messages")
          .update({ read_at: new Date().toISOString() })
          .eq("sender_type", "client")
          .is("read_at", null)

        if (account_id) {
          updateQuery = updateQuery.eq("account_id", account_id)
        } else {
          updateQuery = updateQuery.eq("contact_id", contact_id!).is("account_id", null)
        }

        const { error } = await updateQuery

        if (error) return { content: [{ type: "text" as const, text: `Failed to mark as read: ${error.message}` }] }

        // Get name for confirmation
        let name = ""
        if (account_id) {
          const { data: acct } = await supabaseAdmin.from("accounts").select("company_name").eq("id", account_id).single()
          name = acct?.company_name ?? account_id
        } else if (contact_id) {
          const { data: ct } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contact_id).single()
          name = ct?.full_name ?? contact_id!
        }

        return {
          content: [{
            type: "text" as const,
            text: count && count > 0
              ? `Marked ${count} message${count !== 1 ? "s" : ""} as read for ${name}.`
              : `No unread messages to mark for ${name}.`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `❌ portal_chat_mark_read error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_send ────────────────────────────────────────────────

  server.tool(
    "portal_chat_send",
    `Send a message to a client via the portal chat system. The message appears in the client's portal chat immediately. Use for day-to-day communication with portal-enabled clients.

Supports both:
- **Account-level chat** (pass account_id): Messages about a specific LLC
- **Contact-level chat** (pass contact_id): Messages to a person (may not have an LLC yet)

The sender is set to 'admin' (staff). The client sees it in their portal chat.`,
    {
      account_id: z.string().uuid().optional().describe("Account UUID for LLC-related messages. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID for person-level messages. At least one of account_id or contact_id required."),
      message: z.string().describe("Message text to send"),
      attachment_url: z.string().optional().describe("Optional single attachment URL (legacy, for backward compat)"),
      attachment_name: z.string().optional().describe("Optional single attachment filename (legacy, for backward compat)"),
      attachments: z.array(z.object({
        url: z.string(),
        name: z.string(),
        mime_type: z.string().optional(),
        size: z.number().optional(),
      })).optional().describe("Array of file attachments. Preferred over attachment_url for one or more files."),
    },
    async ({ account_id, contact_id, message: msgText, attachment_url, attachment_name, attachments }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of account_id or contact_id is required." }] }
        }

        // Admin sender ID (Antonio's auth user ID)
        const senderId = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

        // Send-scope invariant (2026-08-07 cross-company leak, dev job 4bad3094):
        // when BOTH ids are passed, the account must actually be one of the
        // contact's companies — a mismatched pair is exactly how private
        // messages ended up readable by another company's member. Fails closed.
        if (account_id && contact_id) {
          const linked = await isContactLinkedToAccount(account_id, contact_id)
          if (!linked) {
            return {
              content: [{
                type: "text" as const,
                text: "Error: the contact is not a member of that account — sending would expose the message to the wrong client's company thread. Pass one of the contact's own accounts, or send with contact_id only (personal thread).",
              }],
            }
          }
        }

        // LANGUAGE GUARD — this tool is a third, independent way a portal message
        // reaches a client (Claude Code / Claude.ai sessions, not the AI worker
        // surfaces), and it had NO language check at all (2026-08-22, dev job
        // 6a927407): the AI-worker paths use shouldRefusePortalDraftLanguage, this
        // tool never called it, sending immediately with zero check. Same guard,
        // same "client language on file is Italian, draft is English" rule.
        const { shouldRefusePortalDraftLanguage } = await import("@/lib/ai-agent/worker-tools")
        const refuseLanguage = await shouldRefusePortalDraftLanguage({
          account_id: account_id ?? null,
          contact_id: contact_id ?? null,
          message: msgText,
        })
        if (refuseLanguage) {
          return {
            content: [{
              type: "text" as const,
              text: "Not sent — this client's language on file is Italian, but the message is in English. Draft the message in Italian and try again. (TD rule: a client-facing send must match the client's language on file — do not translate and resend without showing the new draft first.)",
            }],
          }
        }

        // Resolve contact_id: if only account_id was provided, tag the member
        // actually being answered — deterministically (reply-author → last
        // client sender → primary/first), via the same shared helper the chat
        // route uses. Replaces the old arbitrary `.limit(1)` pick that tagged
        // the wrong MMLLC member.
        let resolvedContactId = contact_id || null
        if (!resolvedContactId && account_id) {
          resolvedContactId = await resolveAdminReplyContact(account_id, null)
        }

        const { data: msg, error } = await supabaseAdmin
          .from("portal_messages")
          .insert({
            account_id: account_id || null,
            contact_id: resolvedContactId,
            sender_type: "admin",
            sender_id: senderId,
            message: msgText,
            attachment_url: attachment_url || null,
            attachment_name: attachment_name || null,
            attachments: attachments ?? [],
          })
          .select("id, created_at")
          .single()

        if (error) return { content: [{ type: "text" as const, text: `Failed to send message: ${error.message}` }] }

        await logAction({
          action_type: "create",
          table_name: "portal_messages",
          record_id: msg.id,
          account_id: account_id || undefined,
          summary: `Portal chat message sent: "${msgText.substring(0, 80)}${msgText.length > 80 ? "..." : ""}"`,
        })

        // Staff reply = read (WhatsApp semantics): clear this conversation's
        // client unread so the staff red dot goes away. Same helper the reply
        // API uses, so every send surface behaves identically.
        const { markClientMessagesReadForStaffReply } = await import("@/lib/portal/mark-thread-read")
        await markClientMessagesReadForStaffReply({
          account_id: account_id || null,
          contact_id: resolvedContactId || null,
          // This tool never tags its own insert with a topic — the message
          // always lands in General, so the read-clear must match (2026-08-30).
          topic: null,
        }).catch(() => 0)

        // In-app notification + email to client (fire-and-forget)
        const { createPortalNotification, notifyClientOfAdminMessage } = await import("@/lib/portal/notifications")
        createPortalNotification({
          account_id: account_id || undefined,
          contact_id: contact_id || undefined,
          type: "chat",
          title: "New message from Tony Durante Team",
          body: msgText.slice(0, 100),
          link: "/portal/chat",
        }).catch(() => {})
        notifyClientOfAdminMessage({
          account_id: account_id || null,
          contact_id: contact_id || null,
          messagePreview: msgText,
        }).catch(() => {})

        // Identify recipient for confirmation
        let recipientName = ""
        if (account_id) {
          const { data: acct } = await supabaseAdmin.from("accounts").select("company_name").eq("id", account_id).single()
          recipientName = acct?.company_name || account_id
        } else if (contact_id) {
          const { data: cnt } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contact_id).single()
          recipientName = cnt?.full_name || contact_id
        }

        return {
          content: [{
            type: "text" as const,
            text: `Message sent to ${recipientName} via portal chat.\nMessage ID: ${msg.id}\nTimestamp: ${msg.created_at}`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_attach_file ────────────────────────────────────────────

  server.tool(
    "portal_chat_attach_file",
    `Move a file that already exists in Drive, Gmail, a URL, or Supabase Storage into the SAME public storage the portal chat's own attachments use, and return a link ready to pass into portal_chat_send's "attachments" array. This does NOT send anything — call portal_chat_send afterward with the returned url/name/mime_type/size.

Use this to hand a client a file we generated or already hold (a P&L export, a signed agreement, a document from Drive) directly in a chat message, without depending on that file's Drive sharing permissions — the destination bucket is public by design, exactly like the files clients themselves upload in chat.

Workflow for a Drive file: source='drive' + file_id. Google-native files (Docs/Sheets/Slides) are exported automatically (Sheets→xlsx, Docs/Slides→pdf).
Workflow for a Gmail attachment: source='gmail' + message_id + attachment_id.
Workflow for a URL: source='url' + url.
Workflow for Supabase Storage: source='supabase_storage' + storage_path — reads from the SAME public "assets" bucket this tool writes to (e.g. a raw chat-attachment path a client already uploaded to). Cannot read any other bucket — TD's onboarding/banking/ITIN upload buckets hold sensitive intake documents and were deliberately locked down; this tool never reaches them.

Requires account_id or contact_id — whichever thread the file is headed to — since that determines the storage folder. Max 20MB — this tool holds the whole file in memory for the copy (unlike the client's own 100MB browser-to-storage upload, which never touches server memory), but 20MB comfortably covers any real document (scans, PDFs, spreadsheets) with margin to spare.`,
    {
      source: z.enum(["drive", "gmail", "url", "supabase_storage"]).describe("Where to get the file: 'drive' = Google Drive file, 'gmail' = Gmail attachment, 'url' = download from URL, 'supabase_storage' = a path already inside the public 'assets' bucket"),
      account_id: z.string().uuid().optional().describe("Account UUID for the LLC thread the file is headed to. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID for the person-level thread the file is headed to. At least one of account_id or contact_id required."),
      filename: z.string().optional().describe("Override filename (auto-detected from source if omitted)"),
      file_id: z.string().optional().describe("Google Drive file ID (required when source='drive')"),
      message_id: z.string().optional().describe("Gmail message ID (required when source='gmail')"),
      attachment_id: z.string().optional().describe("Gmail attachment ID from message parts (required when source='gmail')"),
      url: z.string().optional().describe("Direct download URL (required when source='url')"),
      storage_path: z.string().optional().describe("Path inside the public 'assets' bucket (required when source='supabase_storage')"),
    },
    async ({ source, account_id, contact_id, filename, file_id, message_id, attachment_id, url, storage_path }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: account_id or contact_id is required — it determines which client's chat storage folder the file lands in." }] }
        }

        let buffer: Buffer
        let finalFilename: string
        let mimeType: string

        if (source === "drive") {
          if (!file_id) {
            return { content: [{ type: "text" as const, text: "Error: file_id is required when source='drive'." }] }
          }
          // Fail fast, before spending a download, if this file isn't even
          // inside the target account's own Drive folder — a wrong or
          // copy-pasted file_id must never silently land one client's file in
          // another client's chat thread. No equivalent check for a
          // contact-only thread (no Drive folder of its own) — mandatory
          // human review before portal_chat_send is the only guard there.
          if (account_id && !(await driveFileBelongsToAccount(file_id, account_id))) {
            return { content: [{ type: "text" as const, text: "Error: this file doesn't appear to be inside that account's own Drive folder. Double-check the file_id and account_id — if this is intentional (e.g. a document from outside the client's own folder), flag it to Antonio rather than attaching it directly." }] }
          }
          const result = await downloadFileBinaryForSend(file_id)
          buffer = result.buffer
          mimeType = result.mimeType
          finalFilename = filename || result.fileName
        } else if (source === "gmail") {
          if (!message_id || !attachment_id) {
            return { content: [{ type: "text" as const, text: "Error: message_id and attachment_id are required when source='gmail'. Use gmail_read first to get these values." }] }
          }
          const { data } = await getGmailAttachment(message_id, attachment_id)
          buffer = data
          if (filename) {
            finalFilename = filename
            mimeType = guessMimeType(filename)
          } else {
            const { gmailGet } = await import("@/lib/gmail")
            type GmailPart = { filename?: string; mimeType: string; body?: { attachmentId?: string }; parts?: GmailPart[] }
            const msg = (await gmailGet(`/messages/${message_id}`, { format: "full" })) as { payload: GmailPart }
            // Recurse into nested parts (e.g. a forwarded message wrapper) —
            // a top-level-only search silently fabricates a filename/mimetype
            // for a real, correctly-fetched attachment that just isn't at the
            // top level, and that mislabeled result reaches a real client.
            const findPart = (parts: GmailPart[] | undefined): GmailPart | undefined => {
              for (const p of parts ?? []) {
                if (p.body?.attachmentId === attachment_id) return p
                const nested = findPart(p.parts)
                if (nested) return nested
              }
              return undefined
            }
            const part = findPart(msg.payload.parts)
            finalFilename = part?.filename || `attachment-${Date.now()}`
            mimeType = part?.mimeType || guessMimeType(finalFilename)
          }
        } else if (source === "url") {
          if (!url) {
            return { content: [{ type: "text" as const, text: "Error: url is required when source='url'." }] }
          }
          const res = await fetch(url)
          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Error: failed to download from URL: ${res.status} ${res.statusText}` }] }
          }
          buffer = Buffer.from(await res.arrayBuffer())
          const disposition = res.headers.get("content-disposition")
          if (filename) {
            finalFilename = filename
          } else if (disposition) {
            const match = disposition.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)/i)
            finalFilename = match ? decodeURIComponent(match[1]) : `download-${Date.now()}`
          } else {
            finalFilename = new URL(url).pathname.split("/").pop() || `download-${Date.now()}`
          }
          mimeType = res.headers.get("content-type") || guessMimeType(finalFilename)
        } else {
          if (!storage_path) {
            return { content: [{ type: "text" as const, text: "Error: storage_path is required when source='supabase_storage'." }] }
          }
          // Hard-pinned to "assets" — the only bucket this tool ever reads OR
          // writes. No caller-supplied bucket name: the sensitive intake
          // buckets (onboarding/banking/ITIN uploads) were deliberately
          // locked down from public access after a real exposure, and a
          // configurable source bucket here would let a service-role read
          // republish any of them straight back onto the public bucket.
          const cleanPath = storage_path.replace(/^\/+/, "")
          const { data: blob, error: dlErr } = await supabaseAdmin.storage.from("assets").download(cleanPath)
          if (dlErr || !blob) {
            return { content: [{ type: "text" as const, text: `Error: failed to download from Supabase Storage (assets/${cleanPath}): ${dlErr?.message || "no data returned"}` }] }
          }
          buffer = Buffer.from(await blob.arrayBuffer())
          finalFilename = filename || cleanPath.split("/").pop() || `storage-file-${Date.now()}`
          mimeType = blob.type || guessMimeType(finalFilename)
        }

        // 20MB, not drive_upload_file's 4MB or the client-upload path's
        // 100MB: this tool holds the whole file in memory for the copy
        // (unlike a browser's direct-to-storage PUT), so the real constraint
        // is memory/time for one buffer, not a platform upload ceiling — 20MB
        // is comfortably past any real document while staying well short of
        // anything that would actually strain a single function call.
        const MAX_SIZE = 20 * 1024 * 1024
        if (buffer.length > MAX_SIZE) {
          return { content: [{ type: "text" as const, text: `Error: file too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Max supported: ~20MB.` }] }
        }

        // Same active-content block-list every other writer into this PUBLIC
        // bucket already goes through (client upload, staff chat senders) —
        // a URL/Gmail/Drive source's declared type is untrusted, and this
        // bucket serves whatever lands in it directly to a browser.
        const attachmentError = validateChatAttachment(finalFilename, buffer.length, mimeType)
        if (attachmentError) {
          return { content: [{ type: "text" as const, text: `Error: ${attachmentError}` }] }
        }

        const destPath = buildChatAttachmentPath(finalFilename, account_id ?? null, contact_id ?? null)
        const { error: uploadError } = await supabaseAdmin.storage
          .from("assets")
          .upload(destPath, buffer, { contentType: mimeType, upsert: false })
        if (uploadError) {
          return { content: [{ type: "text" as const, text: `Error: upload failed: ${uploadError.message}` }] }
        }

        // The access-controlled proxy, not the bucket's own getPublicUrl —
        // this bucket is still technically public (see
        // docs/SECURITY-chat-attachments-cutover.md), but new code has no
        // reason to hand out a permanent, unauthenticated link when the
        // already-built, already-safe proxy works today regardless of the
        // bucket's public/private state and needs zero new backend code.
        const proxyUrl = `${PORTAL_BASE_URL}/api/portal/chat/attachment?path=${encodeURIComponent(destPath)}`

        await logAction({
          action_type: "create",
          table_name: "portal_chat_attachment",
          record_id: destPath,
          account_id: account_id || undefined,
          contact_id: contact_id || undefined,
          summary: `Staged chat attachment from ${source}: ${finalFilename} (${(buffer.length / 1024).toFixed(1)}KB)`,
        })

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Ready to attach`,
              ``,
              `Name: ${finalFilename}`,
              `Type: ${mimeType}`,
              `Size: ${(buffer.length / 1024).toFixed(1)}KB`,
              `URL: ${proxyUrl}`,
              ``,
              `Pass this to portal_chat_send as one entry in "attachments":`,
              `{ "url": "${proxyUrl}", "name": "${finalFilename}", "mime_type": "${mimeType}", "size": ${buffer.length} }`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_team_send ─────────────────────────────────────────────────

  server.tool(
    "portal_team_send",
    `Send an internal team message visible ONLY to staff (Antonio, Luca, Claude). NOT visible to clients.

Creates or reuses an internal discussion thread linked to a client account or contact. The message appears in the CRM dashboard under Portal Chats > Team tab. Staff receive real-time toast notifications + push notifications.

Use this for:
- Flagging something for Luca to check (e.g., "Check Delaware SOS for this company")
- Internal notes about a client situation
- Team coordination on a client case

NEVER use portal_chat_send for team-only messages — clients can see those.

Supports both:
- **Account-level** (pass account_id): Discussion about a specific LLC
- **Contact-level** (pass contact_id): Discussion about a person (may not have an LLC yet)`,
    {
      account_id: z.string().uuid().optional().describe("Account UUID for LLC-related discussions. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID for person-level discussions. At least one of account_id or contact_id required."),
      message: z.string().describe("Team message text"),
      source_message_id: z.string().uuid().optional().describe("Portal message ID that triggered this discussion (optional, for context)"),
    },
    async ({ account_id, contact_id, message: msgText, source_message_id }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of account_id or contact_id is required." }] }
        }

        // Resolve context name for thread title
        let contextName = "Client"
        if (account_id) {
          const { data: acct } = await supabaseAdmin.from("accounts").select("company_name").eq("id", account_id).single()
          contextName = acct?.company_name || account_id
        } else if (contact_id) {
          const { data: cnt } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contact_id).single()
          contextName = cnt?.full_name || contact_id
        }

        // Check for existing unresolved thread — reuse it
        let query = supabaseAdmin
          .from("internal_threads")
          .select("*")
          .is("resolved_at", null)
          .order("created_at", { ascending: false })
          .limit(1)

        if (account_id) {
          query = query.eq("account_id", account_id)
        } else {
          query = query.eq("contact_id", contact_id!)
        }

        const { data: existingThread } = await query.single()

        // Admin sender ID (Claude uses Antonio's admin ID as sender context)
        const senderId = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"
        const senderName = "Claude"

        let threadId: string
        let reused = false

        if (existingThread) {
          threadId = existingThread.id
          reused = true
        } else {
          // Create new thread
          const { data: newThread, error: threadErr } = await supabaseAdmin
            .from("internal_threads")
            .insert({
              account_id: account_id || null,
              contact_id: contact_id || null,
              source_message_id: source_message_id || null,
              created_by: senderId,
              title: contextName,
            })
            .select("id")
            .single()

          if (threadErr) return { content: [{ type: "text" as const, text: `Failed to create thread: ${threadErr.message}` }] }
          threadId = newThread.id
        }

        // Insert the message
        const { data: msg, error: msgErr } = await supabaseAdmin
          .from("internal_messages")
          .insert({
            thread_id: threadId,
            sender_id: senderId,
            sender_name: senderName,
            message: msgText,
          })
          .select("id, created_at")
          .single()

        if (msgErr) return { content: [{ type: "text" as const, text: `Failed to send message: ${msgErr.message}` }] }

        // Send push notification to all admins
        try {
          // No pre-check on the subscription table: who receives is decided by
          // the staff directory inside sendPushToStaffExcept, and a failed probe
          // here used to swallow the notification with no log.
          const { sendPushToStaffExcept } = await import("@/lib/team/notify")
          await sendPushToStaffExcept(senderId, {
            title: `Team: ${contextName}`,
            body: msgText.slice(0, 100),
            url: "/portal-chats?view=internal",
            tag: `internal-thread-${threadId}`,
          })
        } catch {
          // Push notification failure is non-critical
        }

        await logAction({
          action_type: "create",
          table_name: "internal_messages",
          record_id: msg.id,
          account_id: account_id || undefined,
          summary: `Team message sent re: ${contextName}: "${msgText.substring(0, 80)}${msgText.length > 80 ? "..." : ""}"`,
        })

        return {
          content: [{
            type: "text" as const,
            text: `Team message sent re: ${contextName}${reused ? " (added to existing thread)" : " (new thread created)"}.\nThread ID: ${threadId}\nMessage ID: ${msg.id}\nTimestamp: ${msg.created_at}\n\nVisible in CRM > Portal Chats > Team tab.`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )
}
