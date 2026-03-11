/**
 * Gmail MCP Tools
 * Search, read, and draft emails via Gmail API.
 * Uses the same SA with DWD as Drive (impersonates support@tonydurante.us).
 *
 * Scopes: gmail.readonly, gmail.compose, gmail.modify
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { SignJWT, importPKCS8 } from "jose"

// ─── Configuration ──────────────────────────────────────────

interface SACredentials {
  client_email: string
  private_key: string
  token_uri: string
}

// Per-user token cache (SA+DWD can impersonate any domain user)
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

function getCredentials(): SACredentials {
  const b64 = process.env.GOOGLE_SA_KEY
  if (!b64) throw new Error("GOOGLE_SA_KEY not configured")
  const json = Buffer.from(b64, "base64").toString("utf-8")
  return JSON.parse(json)
}

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
].join(" ")

const DEFAULT_EMAIL = () =>
  process.env.GOOGLE_IMPERSONATE_EMAIL || "support@tonydurante.us"

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1"

// ─── Token Management (per-user) ────────────────────────────

async function getGmailToken(asUser?: string): Promise<{ token: string; userEmail: string }> {
  const userEmail = asUser || DEFAULT_EMAIL()
  const cached = tokenCache.get(userEmail)

  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return { token: cached.token, userEmail }
  }

  const creds = getCredentials()
  const now = Math.floor(Date.now() / 1000)

  const privateKey = await importPKCS8(creds.private_key, "RS256")
  const assertion = await new SignJWT({
    scope: GMAIL_SCOPES,
    sub: userEmail,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(creds.client_email)
    .setAudience(creds.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey)

  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail OAuth error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  tokenCache.set(userEmail, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  })

  return { token: data.access_token, userEmail }
}

// ─── API Helpers ────────────────────────────────────────────

async function gmailGet(endpoint: string, params?: Record<string, string | string[]>, asUser?: string) {
  const { token, userEmail } = await getGmailToken(asUser)
  const url = new URL(`${GMAIL_API}/users/${userEmail}${endpoint}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          url.searchParams.append(k, item)
        }
      } else {
        url.searchParams.set(k, v)
      }
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Gmail API ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

async function gmailPost(endpoint: string, body: Record<string, unknown>, asUser?: string) {
  const { token, userEmail } = await getGmailToken(asUser)

  const res = await fetch(`${GMAIL_API}/users/${userEmail}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Gmail API ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

// ─── Email Parsing Helpers ──────────────────────────────────

interface GmailHeader {
  name: string
  value: string
}

interface GmailPart {
  mimeType: string
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet: string
  payload: {
    headers: GmailHeader[]
    mimeType: string
    body?: { data?: string; size?: number }
    parts?: GmailPart[]
  }
  internalDate: string
}

function getHeader(headers: GmailHeader[] | undefined, name: string): string {
  if (!headers) return ""
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ""
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(base64, "base64").toString("utf-8")
}

function extractBody(payload: GmailMessage["payload"]): string {
  // Try to get plain text body first
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }

  if (payload.parts) {
    // Look for text/plain first
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data)
      }
    }
    // Then text/html
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = decodeBase64Url(part.body.data)
        // Strip HTML tags for readability
        return html
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .trim()
      }
    }
    // Recurse into multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const body = extractBody({ headers: [], mimeType: part.mimeType, parts: part.parts })
        if (body) return body
      }
    }
  }

  return "(no readable body)"
}

// ─── Tool Registration ──────────────────────────────────────

export function registerGmailTools(server: McpServer) {

  // ═══════════════════════════════════════
  // gmail_search
  // ═══════════════════════════════════════
  server.tool(
    "gmail_search",
    "Search emails in Gmail. Default mailbox: support@tonydurante.us. Use as_user='antonio.durante@tonydurante.us' for Antonio's personal inbox. Supports Gmail search syntax: from:, to:, subject:, has:attachment, is:unread, after:YYYY/MM/DD, before:, label:, in:anywhere. Returns message IDs, subjects, senders, dates, and snippets. Use gmail_read with the message ID to get the full email body.",
    {
      query: z.string().describe("Gmail search query (e.g. 'from:client@example.com', 'subject:invoice is:unread', 'after:2026/01/01 has:attachment')"),
      max_results: z.number().optional().default(15).describe("Max results (default 15, max 50)"),
      as_user: z.string().optional().describe("Mailbox to access (default: support@tonydurante.us). E.g. 'antonio.durante@tonydurante.us'"),
    },
    async ({ query, max_results, as_user }) => {
      try {
        const listResult = await gmailGet("/messages", {
          q: query,
          maxResults: String(Math.min(max_results || 15, 50)),
        }, as_user) as { messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }

        if (!listResult.messages || listResult.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: `📭 No emails found for: ${query}` }],
          }
        }

        const lines = [
          `🔍 Found ~${listResult.resultSizeEstimate || listResult.messages.length} emails (showing ${listResult.messages.length})`,
          "",
        ]

        // Fetch details for each message (limited batch)
        for (const msg of listResult.messages.slice(0, 15)) {
          const detail = await gmailGet(`/messages/${msg.id}`, {
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          }, as_user) as GmailMessage

          const from = getHeader(detail.payload.headers, "From")
          const subject = getHeader(detail.payload.headers, "Subject")
          const date = getHeader(detail.payload.headers, "Date")
          const isUnread = detail.labelIds?.includes("UNREAD") ? "🔵" : "  "

          lines.push(`${isUnread} 📧 ${subject || "(no subject)"}`)
          lines.push(`   👤 ${from}`)
          lines.push(`   📅 ${date}`)
          lines.push(`   💬 ${detail.snippet}`)
          lines.push(`   🆔 Message: ${msg.id}  |  Thread: ${msg.threadId}`)
          lines.push("")
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Gmail search failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // gmail_read
  // ═══════════════════════════════════════
  server.tool(
    "gmail_read",
    "Read the full content of a single email by message ID (from gmail_search results). Returns subject, from, to, CC, date, labels, and decoded body text. Use gmail_read_thread instead if you need the entire conversation.",
    {
      message_id: z.string().describe("Gmail message ID (from gmail_search results)"),
      as_user: z.string().optional().describe("Mailbox to access (default: support@tonydurante.us)"),
    },
    async ({ message_id, as_user }) => {
      try {
        const msg = await gmailGet(`/messages/${message_id}`, {
          format: "full",
        }, as_user) as GmailMessage

        const from = getHeader(msg.payload.headers, "From")
        const to = getHeader(msg.payload.headers, "To")
        const cc = getHeader(msg.payload.headers, "Cc")
        const subject = getHeader(msg.payload.headers, "Subject")
        const date = getHeader(msg.payload.headers, "Date")
        const body = extractBody(msg.payload)

        const lines = [
          `📧 ${subject || "(no subject)"}`,
          "",
          `👤 From: ${from}`,
          `📬 To: ${to}`,
          cc ? `📋 CC: ${cc}` : "",
          `📅 Date: ${date}`,
          `🏷️ Labels: ${msg.labelIds?.join(", ") || "none"}`,
          "",
          "── Body ──────────────────────────────",
          body.length > 5000 ? body.slice(0, 5000) + "\n\n⚠️ Truncated (5000 chars)" : body,
        ].filter(Boolean)

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Gmail read failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // gmail_read_thread
  // ═══════════════════════════════════════
  server.tool(
    "gmail_read_thread",
    "Read an entire email thread (conversation) by thread ID (from gmail_search results). Returns all messages in chronological order with sender, date, and body text. Use this to see the full back-and-forth of a conversation.",
    {
      thread_id: z.string().describe("Gmail thread ID (from gmail_search results)"),
      as_user: z.string().optional().describe("Mailbox to access (default: support@tonydurante.us)"),
    },
    async ({ thread_id, as_user }) => {
      try {
        const thread = await gmailGet(`/threads/${thread_id}`, {
          format: "full",
        }, as_user) as { id: string; messages: GmailMessage[] }

        const lines = [
          `📧 Thread: ${thread.messages.length} messages`,
          "",
        ]

        for (const msg of thread.messages) {
          const from = getHeader(msg.payload.headers, "From")
          const date = getHeader(msg.payload.headers, "Date")
          const subject = getHeader(msg.payload.headers, "Subject")
          const body = extractBody(msg.payload)

          lines.push(`── ${date} ──`)
          lines.push(`👤 ${from}`)
          if (subject) lines.push(`📋 ${subject}`)
          lines.push("")
          lines.push(body.length > 2000 ? body.slice(0, 2000) + "..." : body)
          lines.push("")
          lines.push("─".repeat(40))
          lines.push("")
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Gmail thread read failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // gmail_draft
  // ═══════════════════════════════════════
  server.tool(
    "gmail_draft",
    "Create an email draft in Gmail (does NOT send). Default mailbox: support@tonydurante.us. The draft is saved and must be reviewed and sent manually from Gmail. Supports reply threading via reply_to_message_id. For immediate sending, use email_send (Postmark) instead.",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC recipient(s)"),
      bcc: z.string().optional().describe("BCC recipient(s)"),
      reply_to_message_id: z.string().optional().describe("If replying, the original Gmail message ID to thread with"),
      as_user: z.string().optional().describe("Mailbox to create draft in (default: support@tonydurante.us)"),
    },
    async ({ to, subject, body, cc, bcc, reply_to_message_id, as_user }) => {
      try {
        const fromEmail = as_user || DEFAULT_EMAIL()

        // Build RFC 2822 email
        const headers = [
          `From: ${fromEmail}`,
          `To: ${to}`,
          `Subject: ${subject}`,
        ]
        if (cc) headers.push(`Cc: ${cc}`)
        if (bcc) headers.push(`Bcc: ${bcc}`)
        headers.push("Content-Type: text/plain; charset=utf-8")

        // If replying, add threading headers
        let threadId: string | undefined
        if (reply_to_message_id) {
          const original = await gmailGet(`/messages/${reply_to_message_id}`, {
            format: "metadata",
            metadataHeaders: "Message-ID,References",
          }, as_user) as GmailMessage

          const originalMessageId = getHeader(original.payload.headers, "Message-ID")
          const references = getHeader(original.payload.headers, "References")

          if (originalMessageId) {
            headers.push(`In-Reply-To: ${originalMessageId}`)
            headers.push(`References: ${references ? references + " " : ""}${originalMessageId}`)
          }
          threadId = original.threadId
        }

        const raw = headers.join("\r\n") + "\r\n\r\n" + body
        const encodedRaw = Buffer.from(raw).toString("base64url")

        const draftPayload: Record<string, unknown> = {
          message: { raw: encodedRaw },
        }
        if (threadId) {
          (draftPayload.message as Record<string, unknown>).threadId = threadId
        }

        const result = await gmailPost("/drafts", draftPayload, as_user) as {
          id: string
          message: { id: string; threadId: string }
        }

        return {
          content: [{
            type: "text" as const,
            text: [
              "✅ Draft created in Gmail",
              "",
              `📧 To: ${to}`,
              `📋 Subject: ${subject}`,
              cc ? `📋 CC: ${cc}` : "",
              `🆔 Draft ID: ${result.id}`,
              `📨 Message ID: ${result.message.id}`,
              "",
              "⚠️ Draft saved — review and send from Gmail.",
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Gmail draft failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // gmail_send
  // ═══════════════════════════════════════
  server.tool(
    "gmail_send",
    "Send an email directly via Gmail API (NOT a draft — sends immediately). Email appears in Gmail Sent folder, supports threading, and tracks opens via pixel. Use this instead of email_send (Postmark) for client emails that need reply threading. Supports HTML body for professional formatting. Returns gmail message_id and thread_id. Optionally link to CRM account/contact/lead for tracking.",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body_html: z.string().describe("HTML email body (supports rich formatting)"),
      body_text: z.string().optional().describe("Plain text fallback (auto-generated from HTML if omitted)"),
      cc: z.string().optional().describe("CC recipient(s), comma-separated"),
      bcc: z.string().optional().describe("BCC recipient(s), comma-separated"),
      reply_to: z.string().optional().describe("Reply-To address (defaults to From)"),
      reply_to_message_id: z.string().optional().describe("Gmail message ID to reply to (creates thread)"),
      as_user: z.string().optional().describe("Send as (default: support@tonydurante.us)"),
      track_opens: z.boolean().optional().default(true).describe("Inject open tracking pixel (default: true)"),
      account_id: z.string().optional().describe("Link to CRM account UUID for tracking"),
      contact_id: z.string().optional().describe("Link to CRM contact UUID for tracking"),
      lead_id: z.string().optional().describe("Link to CRM lead UUID for tracking"),
      tag: z.string().optional().describe("Tag for categorizing (e.g. 'onboarding', 'invoice', 'support')"),
    },
    async ({ to, subject, body_html, body_text, cc, bcc, reply_to, reply_to_message_id, as_user, track_opens, account_id, contact_id, lead_id, tag }) => {
      try {
        const fromEmail = as_user || DEFAULT_EMAIL()

        // Generate tracking ID
        const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

        // Inject tracking pixel if enabled
        let htmlBody = body_html
        if (track_opens !== false) {
          const pixelUrl = `https://td-operations.vercel.app/api/track/open/${trackingId}`
          // Insert pixel before closing </body> or at end
          if (htmlBody.includes("</body>")) {
            htmlBody = htmlBody.replace("</body>", `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" /></body>`)
          } else {
            htmlBody += `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`
          }
        }

        // Generate plain text from HTML if not provided
        const plainText = body_text || htmlBody
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<\/div>/gi, "\n")
          .replace(/<\/li>/gi, "\n")
          .replace(/<li>/gi, "• ")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/\n{3,}/g, "\n\n")
          .trim()

        // Build MIME multipart message (text + html)
        const boundary = `boundary_${Date.now()}`
        const mimeHeaders = [
          `From: Tony Durante LLC <${fromEmail}>`,
          `To: ${to}`,
          `Subject: ${subject}`,
        ]
        if (cc) mimeHeaders.push(`Cc: ${cc}`)
        if (bcc) mimeHeaders.push(`Bcc: ${bcc}`)
        if (reply_to) mimeHeaders.push(`Reply-To: ${reply_to}`)
        mimeHeaders.push("MIME-Version: 1.0")
        mimeHeaders.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)

        // Threading headers
        let threadId: string | undefined
        if (reply_to_message_id) {
          const original = await gmailGet(`/messages/${reply_to_message_id}`, {
            format: "metadata",
            metadataHeaders: "Message-ID,References",
          }, as_user) as GmailMessage

          const originalMsgId = getHeader(original.payload.headers, "Message-ID")
          const references = getHeader(original.payload.headers, "References")

          if (originalMsgId) {
            mimeHeaders.push(`In-Reply-To: ${originalMsgId}`)
            mimeHeaders.push(`References: ${references ? references + " " : ""}${originalMsgId}`)
          }
          threadId = original.threadId
        }

        if (tag) {
          mimeHeaders.push(`X-Tag: ${tag}`)
        }

        const mimeBody = [
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
        ].join("\r\n")

        const encodedRaw = Buffer.from(mimeBody).toString("base64url")

        const sendPayload: Record<string, unknown> = {
          raw: encodedRaw,
        }
        if (threadId) {
          sendPayload.threadId = threadId
        }

        // Send via Gmail API
        const result = await gmailPost("/messages/send", sendPayload, as_user) as {
          id: string
          threadId: string
          labelIds: string[]
        }

        // Save tracking record
        if (track_opens !== false) {
          const { createClient } = await import("@supabase/supabase-js")
          const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
          )
          await supabase.from("email_tracking").insert({
            tracking_id: trackingId,
            gmail_message_id: result.id,
            gmail_thread_id: result.threadId,
            recipient: to,
            subject,
            from_email: fromEmail,
            account_id: account_id || null,
            contact_id: contact_id || null,
            lead_id: lead_id || null,
          })
        }

        return {
          content: [{
            type: "text" as const,
            text: [
              "✅ Email sent via Gmail",
              "",
              `📧 To: ${to}`,
              `📋 Subject: ${subject}`,
              cc ? `📋 CC: ${cc}` : null,
              `🆔 Message ID: ${result.id}`,
              `📨 Thread ID: ${result.threadId}`,
              track_opens !== false ? `👁️ Open tracking: enabled (${trackingId})` : null,
              tag ? `🏷️ Tag: ${tag}` : null,
              "",
              "Email appears in Gmail Sent folder. Client replies will thread automatically.",
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Gmail send failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // gmail_track_status
  // ═══════════════════════════════════════
  server.tool(
    "gmail_track_status",
    "Check open tracking status for emails sent via gmail_send. Search by recipient email, tracking_id, or list recent tracked emails. Shows open count, first/last opened time.",
    {
      recipient: z.string().optional().describe("Filter by recipient email"),
      tracking_id: z.string().optional().describe("Specific tracking ID"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ recipient, tracking_id, limit }) => {
      try {
        const { createClient } = await import("@supabase/supabase-js")
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        let q = supabase
          .from("email_tracking")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit || 20)

        if (tracking_id) q = q.eq("tracking_id", tracking_id)
        if (recipient) q = q.eq("recipient", recipient)

        const { data, error } = await q
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "📭 No tracked emails found." }] }
        }

        const lines = [`📊 Email Tracking (${data.length} results)`, ""]
        for (const t of data) {
          const status = t.opened ? `✅ Opened ${t.open_count}x` : "📭 Not opened"
          const opened = t.first_opened_at ? ` | First: ${new Date(t.first_opened_at).toLocaleString()}` : ""
          lines.push(`${status} | ${t.recipient} | ${t.subject}${opened}`)
          lines.push(`   Sent: ${new Date(t.created_at).toLocaleString()} | ID: ${t.tracking_id}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // gmail_labels
  // ═══════════════════════════════════════
  server.tool(
    "gmail_labels",
    "List all Gmail labels (folders and categories) with unread counts. Default mailbox: support@tonydurante.us. Shows system labels (INBOX, SENT, etc.) and custom labels with IDs. Use label IDs with gmail_search (e.g. 'label:MyLabel').",
    {
      as_user: z.string().optional().describe("Mailbox to access (default: support@tonydurante.us)"),
    },
    async ({ as_user }) => {
      try {
        const result = await gmailGet("/labels", undefined, as_user) as {
          labels: Array<{ id: string; name: string; type: string; messagesTotal?: number; messagesUnread?: number }>
        }

        const lines = ["📂 Gmail Labels", ""]

        // System labels first
        const system = result.labels.filter(l => l.type === "system").sort((a, b) => a.name.localeCompare(b.name))
        const user = result.labels.filter(l => l.type === "user").sort((a, b) => a.name.localeCompare(b.name))

        if (system.length > 0) {
          lines.push("── System ──")
          for (const l of system) {
            const unread = l.messagesUnread ? ` (${l.messagesUnread} unread)` : ""
            lines.push(`  ${l.name}${unread}`)
          }
          lines.push("")
        }

        if (user.length > 0) {
          lines.push("── Custom ──")
          for (const l of user) {
            const unread = l.messagesUnread ? ` (${l.messagesUnread} unread)` : ""
            lines.push(`  🏷️ ${l.name}${unread}  [ID: ${l.id}]`)
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Gmail labels failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

}
