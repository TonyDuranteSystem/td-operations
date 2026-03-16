/**
 * Gmail MCP Tools (9 tools)
 * Search, read, draft, send emails via Gmail API with open tracking.
 * Uses the same SA with DWD as Drive (impersonates support@tonydurante.us).
 *
 * Scopes: gmail.readonly, gmail.compose, gmail.modify, gmail.send
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { SignJWT, importPKCS8 } from "jose"
import { logAction } from "@/lib/mcp/action-log"

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

// ─── ASCII Sanitizer ─────────────────────────────────────────
// Replaces common Unicode characters that cause encoding corruption
// in email clients with their ASCII equivalents.
function sanitizeToAscii(text: string): string {
  return text
    .replace(/\u2014/g, "--")    // em dash
    .replace(/\u2013/g, "-")     // en dash
    .replace(/\u2018/g, "'")     // left single curly quote
    .replace(/\u2019/g, "'")     // right single curly quote
    .replace(/\u201C/g, '"')     // left double curly quote
    .replace(/\u201D/g, '"')     // right double curly quote
    .replace(/\u2022/g, "*")     // bullet
    .replace(/\u2026/g, "...")   // ellipsis
    .replace(/\u2192/g, "->")    // right arrow
    .replace(/\u2190/g, "<-")    // left arrow
    .replace(/\u2194/g, "<->")   // left-right arrow
    .replace(/\u00AB/g, "<<")    // left guillemet
    .replace(/\u00BB/g, ">>")    // right guillemet
    .replace(/\u00A0/g, " ")     // non-breaking space
    .replace(/\u200B/g, "")      // zero-width space
    .replace(/\u200D/g, "")      // zero-width joiner
    .replace(/\uFEFF/g, "")      // BOM
}

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

        // Find attachments
        const findAttachmentsMeta = (parts: GmailPart[] | undefined): Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> => {
          const result: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = []
          if (!parts) return result
          for (const part of parts) {
            if (part.body?.size && part.body.size > 0 && (part as unknown as Record<string, unknown>).filename) {
              const fn = (part as unknown as Record<string, unknown>).filename as string
              if (fn) {
                result.push({
                  filename: fn,
                  mimeType: part.mimeType,
                  size: part.body.size,
                  attachmentId: ((part.body as unknown as Record<string, unknown>).attachmentId as string) || "",
                })
              }
            }
            if (part.parts) result.push(...findAttachmentsMeta(part.parts))
          }
          return result
        }
        const attachmentsList = findAttachmentsMeta(msg.payload.parts)

        const lines = [
          `📧 ${subject || "(no subject)"}`,
          "",
          `👤 From: ${from}`,
          `📬 To: ${to}`,
          cc ? `📋 CC: ${cc}` : "",
          `📅 Date: ${date}`,
          `🏷️ Labels: ${msg.labelIds?.join(", ") || "none"}`,
        ]

        if (attachmentsList.length > 0) {
          lines.push("")
          lines.push(`📎 Attachments (${attachmentsList.length}):`)
          for (const att of attachmentsList) {
            const sizeKb = Math.round(att.size / 1024)
            lines.push(`  📄 ${att.filename} (${att.mimeType}, ${sizeKb} KB) — ID: ${att.attachmentId}`)
          }
          lines.push(`  💡 Use gmail_read_attachment(message_id="${message_id}", attachment_id="...") to download`)
        }

        lines.push("")
        lines.push("── Body ──────────────────────────────")
        lines.push(body.length > 5000 ? body.slice(0, 5000) + "\n\n⚠️ Truncated (5000 chars)" : body)

        return {
          content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
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
    "Create an email draft in Gmail (does NOT send). Default mailbox: support@tonydurante.us. The draft is saved and must be reviewed and sent manually from Gmail. Supports reply threading via reply_to_message_id. For immediate sending, use gmail_send instead.",
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
        // Sanitize all text content to ASCII before processing
        subject = sanitizeToAscii(subject)
        body = sanitizeToAscii(body)

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

        logAction({
          action_type: "create",
          table_name: "gmail",
          record_id: result.message.id,
          summary: `Draft created → ${to}: ${subject}`,
          details: { to, subject, cc: cc || null, reply_to_message_id: reply_to_message_id || null },
        })

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
    "Send an email directly via Gmail API (NOT a draft — sends immediately). Email appears in Gmail Sent folder, supports threading, and tracks opens via pixel. PRIMARY email tool for ALL client communications. Supports HTML body for professional formatting. Returns gmail message_id and thread_id. Optionally link to CRM account/contact/lead for tracking. ATTACHMENTS: Use drive_file_id (singular) to attach a Google Drive file — just pass the file ID from drive_search. The file is downloaded and attached automatically. For multiple files, use drive_file_ids (array).",
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
      drive_file_id: z.string().optional().describe("Google Drive file ID to attach (1st file). The file is downloaded automatically and attached to the email. Use drive_search or drive_list_folder to find the file ID."),
      drive_file_id_2: z.string().optional().describe("Google Drive file ID for a 2nd attachment (optional)."),
      drive_file_id_3: z.string().optional().describe("Google Drive file ID for a 3rd attachment (optional)."),
      drive_file_ids: z.array(z.string()).optional().describe("Multiple Google Drive file IDs to attach (for programmatic use). Prefer drive_file_id params for Claude.ai."),
      attachments: z.array(z.object({
        filename: z.string().describe("File name with extension (e.g. 'Invoice-INV-001364.pdf')"),
        content: z.string().describe("Base64-encoded file content"),
        content_type: z.string().optional().default("application/pdf").describe("MIME type (default: application/pdf)"),
      })).optional().describe("File attachments (base64-encoded). For Drive files, use drive_file_id instead."),
    },
    async ({ to, subject, body_html, body_text, cc, bcc, reply_to, reply_to_message_id, as_user, track_opens, account_id, contact_id, lead_id, tag, drive_file_id, drive_file_id_2, drive_file_id_3, drive_file_ids, attachments }) => {
      try {
        // Sanitize all text content to ASCII before processing
        subject = sanitizeToAscii(subject)
        body_html = sanitizeToAscii(body_html)
        if (body_text) body_text = sanitizeToAscii(body_text)

        const fromEmail = as_user || DEFAULT_EMAIL()

        // Merge all drive_file_id* params into a single array
        const allDriveIds = [...(drive_file_ids || [])]
        if (drive_file_id) allDriveIds.push(drive_file_id)
        if (drive_file_id_2) allDriveIds.push(drive_file_id_2)
        if (drive_file_id_3) allDriveIds.push(drive_file_id_3)

        // Download Drive files and merge with manual attachments
        const allAttachments = [...(attachments || [])]
        if (allDriveIds.length > 0) {
          const { downloadFileBinary } = await import("@/lib/google-drive")
          for (const fileId of allDriveIds) {
            try {
              const { buffer, mimeType, fileName } = await downloadFileBinary(fileId)
              allAttachments.push({
                filename: fileName,
                content: buffer.toString("base64"),
                content_type: mimeType || "application/octet-stream",
              })
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `❌ Failed to download Drive file ${fileId}: ${err instanceof Error ? err.message : String(err)}` }],
              }
            }
          }
        }

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

        // Build MIME message
        const hasAttachments = allAttachments.length > 0
        const outerBoundary = `boundary_${Date.now()}`
        const altBoundary = `alt_boundary_${Date.now()}`

        // RFC 2047: encode subject as base64 if it contains non-ASCII chars
        const hasNonAscii = /[^\x00-\x7F]/.test(subject)
        const encodedSubject = hasNonAscii
          ? `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
          : subject
        const mimeHeaders = [
          `From: Tony Durante LLC <${fromEmail}>`,
          `To: ${to}`,
          `Subject: ${encodedSubject}`,
        ]
        if (cc) mimeHeaders.push(`Cc: ${cc}`)
        if (bcc) mimeHeaders.push(`Bcc: ${bcc}`)
        if (reply_to) mimeHeaders.push(`Reply-To: ${reply_to}`)
        mimeHeaders.push("MIME-Version: 1.0")

        // If attachments: multipart/mixed wrapping multipart/alternative + attachments
        // If no attachments: multipart/alternative (text + html)
        if (hasAttachments) {
          mimeHeaders.push(`Content-Type: multipart/mixed; boundary="${outerBoundary}"`)
        } else {
          mimeHeaders.push(`Content-Type: multipart/alternative; boundary="${outerBoundary}"`)
        }

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

        const mimeParts: string[] = [mimeHeaders.join("\r\n"), ""]

        if (hasAttachments) {
          // multipart/mixed → first part is multipart/alternative (body)
          mimeParts.push(`--${outerBoundary}`)
          mimeParts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`)
          mimeParts.push("")
          mimeParts.push(`--${altBoundary}`)
          mimeParts.push("Content-Type: text/plain; charset=utf-8")
          mimeParts.push("Content-Transfer-Encoding: base64")
          mimeParts.push("")
          mimeParts.push(Buffer.from(plainText).toString("base64"))
          mimeParts.push("")
          mimeParts.push(`--${altBoundary}`)
          mimeParts.push("Content-Type: text/html; charset=utf-8")
          mimeParts.push("Content-Transfer-Encoding: base64")
          mimeParts.push("")
          mimeParts.push(Buffer.from(htmlBody).toString("base64"))
          mimeParts.push("")
          mimeParts.push(`--${altBoundary}--`)

          // Append each attachment
          for (const att of allAttachments) {
            const ct = att.content_type || "application/pdf"
            mimeParts.push("")
            mimeParts.push(`--${outerBoundary}`)
            mimeParts.push(`Content-Type: ${ct}; name="${att.filename}"`)
            mimeParts.push("Content-Transfer-Encoding: base64")
            mimeParts.push(`Content-Disposition: attachment; filename="${att.filename}"`)
            mimeParts.push("")
            mimeParts.push(att.content)
          }
          mimeParts.push("")
          mimeParts.push(`--${outerBoundary}--`)
        } else {
          // No attachments — simple multipart/alternative
          mimeParts.push(`--${outerBoundary}`)
          mimeParts.push("Content-Type: text/plain; charset=utf-8")
          mimeParts.push("Content-Transfer-Encoding: base64")
          mimeParts.push("")
          mimeParts.push(Buffer.from(plainText).toString("base64"))
          mimeParts.push("")
          mimeParts.push(`--${outerBoundary}`)
          mimeParts.push("Content-Type: text/html; charset=utf-8")
          mimeParts.push("Content-Transfer-Encoding: base64")
          mimeParts.push("")
          mimeParts.push(Buffer.from(htmlBody).toString("base64"))
          mimeParts.push("")
          mimeParts.push(`--${outerBoundary}--`)
        }

        const mimeBody = mimeParts.join("\r\n")

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

        logAction({
          action_type: "send",
          table_name: "gmail",
          record_id: result.id,
          account_id: account_id || undefined,
          summary: `Email sent → ${to}: ${subject}`,
          details: { to, subject, cc: cc || null, tag: tag || null, has_attachments: hasAttachments, attachment_count: allAttachments.length },
        })

        // Auto-update lead status when sending offer emails
        let leadAutoUpdate = ""
        if (lead_id && tag === "offer") {
          try {
            const { createClient: createSB } = await import("@supabase/supabase-js")
            const sbAdmin = createSB(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
            const { error: leadErr } = await sbAdmin
              .from("leads")
              .update({ status: "Offer Sent", offer_status: "Sent", updated_at: new Date().toISOString() })
              .eq("id", lead_id)
            if (!leadErr) leadAutoUpdate = "\n📋 Lead auto-updated → Offer Sent"
          } catch { /* non-blocking */ }
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
              hasAttachments ? `📎 Attachments: ${allAttachments.map(a => a.filename).join(", ")}` : null,
              "",
              "Email appears in Gmail Sent folder. Client replies will thread automatically.",
              leadAutoUpdate || null,
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
  // gmail_read_attachment
  // ═══════════════════════════════════════
  server.tool(
    "gmail_read_attachment",
    "Download attachments from a Gmail message. Can list attachments, read text files, or save binary files directly to Google Drive. When save_to_drive_folder_id is provided, downloads the attachment and uploads it to the specified Drive folder automatically — no extra steps needed. Workflow: gmail_search → gmail_read (shows attachments with IDs) → gmail_read_attachment (download/save). To find the client's Drive folder: use crm_get_client_summary to get drive_folder_id, then optionally drive_list_folder to pick a subfolder (e.g. '1. Company', '5. Correspondence').",
    {
      message_id: z.string().describe("Gmail message ID (from gmail_search or gmail_read)"),
      attachment_id: z.string().optional().describe("Specific attachment ID to download (from gmail_read). If omitted, lists all attachments with metadata."),
      save_to_drive_folder_id: z.string().optional().describe("Google Drive folder ID to save the attachment to. If provided, the file is downloaded from Gmail and uploaded to Drive automatically. Use crm_get_client_summary → drive_folder_id to find the client's folder, then drive_list_folder to pick a subfolder."),
      as_user: z.string().optional().describe("Mailbox to access (default: support@tonydurante.us)"),
    },
    async ({ message_id, attachment_id, save_to_drive_folder_id, as_user }) => {
      try {
        // First, get the message to find attachments
        const msg = await gmailGet(`/messages/${message_id}`, {
          format: "full",
        }, as_user) as GmailMessage

        // Recursively find all attachment parts
        type AttachmentInfo = {
          partId: string
          filename: string
          mimeType: string
          size: number
          attachmentId: string
        }

        const findAttachments = (parts: GmailPart[] | undefined, result: AttachmentInfo[] = []): AttachmentInfo[] => {
          if (!parts) return result
          for (const part of parts) {
            if (part.body?.size && part.body.size > 0 && (part as unknown as Record<string, unknown>).filename) {
              const fn = (part as unknown as Record<string, unknown>).filename as string
              if (fn) {
                result.push({
                  partId: (part as unknown as Record<string, unknown>).partId as string || "",
                  filename: fn,
                  mimeType: part.mimeType,
                  size: part.body.size,
                  attachmentId: ((part.body as unknown as Record<string, unknown>).attachmentId as string) || "",
                })
              }
            }
            if (part.parts) findAttachments(part.parts, result)
          }
          return result
        }

        const attachments = findAttachments(msg.payload.parts)

        // Also check top-level payload for single-part messages
        if (msg.payload.body?.size && msg.payload.body.size > 0 && (msg.payload as unknown as Record<string, unknown>).filename) {
          const filename = (msg.payload as unknown as Record<string, unknown>).filename as string
          if (filename) {
            attachments.push({
              partId: "",
              filename,
              mimeType: msg.payload.mimeType,
              size: msg.payload.body.size,
              attachmentId: ((msg.payload.body as unknown as Record<string, unknown>).attachmentId as string) || "",
            })
          }
        }

        if (attachments.length === 0) {
          return {
            content: [{ type: "text" as const, text: `📭 No attachments found in message ${message_id}` }],
          }
        }

        // If no specific attachment requested, list all
        if (!attachment_id) {
          const lines = [
            `📎 ${attachments.length} attachment(s) in message ${message_id}`,
            "",
          ]
          for (const att of attachments) {
            const sizeKb = Math.round(att.size / 1024)
            lines.push(`  📄 ${att.filename}`)
            lines.push(`     Type: ${att.mimeType} | Size: ${sizeKb} KB`)
            lines.push(`     Attachment ID: ${att.attachmentId}`)
            lines.push("")
          }
          lines.push("Use gmail_read_attachment with attachment_id to download a specific file.")
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          }
        }

        // Download the specific attachment
        const attInfo = attachments.find(a => a.attachmentId === attachment_id)
        const attData = await gmailGet(
          `/messages/${message_id}/attachments/${attachment_id}`,
          undefined,
          as_user
        ) as { data: string; size: number }

        // Decode from base64url
        const base64Standard = attData.data.replace(/-/g, "+").replace(/_/g, "/")
        const buffer = Buffer.from(base64Standard, "base64")

        const filename = attInfo?.filename || "attachment"
        const mimeType = attInfo?.mimeType || "application/octet-stream"
        const sizeKb = Math.round(buffer.length / 1024)

        // If save_to_drive_folder_id provided, upload to Drive automatically
        if (save_to_drive_folder_id) {
          try {
            const { uploadBinaryToDrive } = await import("@/lib/google-drive")
            const driveFile = await uploadBinaryToDrive(filename, buffer, mimeType, save_to_drive_folder_id)
            const driveId = (driveFile as { id: string }).id

            logAction({
              action_type: "upload",
              table_name: "google_drive",
              record_id: driveId,
              summary: `Gmail attachment → Drive: ${filename} (${sizeKb} KB)`,
              details: { gmail_message_id: message_id, filename, mimeType, drive_folder_id: save_to_drive_folder_id },
            })

            return {
              content: [{
                type: "text" as const,
                text: [
                  `✅ Attachment saved to Google Drive`,
                  "",
                  `📄 ${filename} (${mimeType}, ${sizeKb} KB)`,
                  `📁 Drive File ID: ${driveId}`,
                  `📂 Folder: ${save_to_drive_folder_id}`,
                  "",
                  `Source: Gmail message ${message_id}`,
                ].join("\n"),
              }],
            }
          } catch (driveErr) {
            return {
              content: [{
                type: "text" as const,
                text: `❌ Downloaded attachment but Drive upload failed: ${driveErr instanceof Error ? driveErr.message : String(driveErr)}\n\nFile: ${filename} (${sizeKb} KB). Try again with drive_upload_file manually.`,
              }],
            }
          }
        }

        // For text-based files, return decoded content
        const textMimeTypes = [
          "text/plain", "text/csv", "text/html", "text/xml",
          "application/json", "application/xml", "text/tab-separated-values",
        ]
        const isText = textMimeTypes.some(t => mimeType.startsWith(t)) ||
          filename.match(/\.(txt|csv|json|xml|tsv|log|md|yaml|yml)$/i)

        if (isText) {
          const textContent = buffer.toString("utf-8")
          const truncated = textContent.length > 10000
          return {
            content: [{
              type: "text" as const,
              text: [
                `📄 ${filename} (${mimeType}, ${sizeKb} KB)`,
                "",
                "── Content ──────────────────────────────",
                truncated ? textContent.slice(0, 10000) + "\n\n⚠️ Truncated at 10,000 chars" : textContent,
              ].join("\n"),
            }],
          }
        }

        // For binary files, return info + instructions
        return {
          content: [{
            type: "text" as const,
            text: [
              `📄 ${filename} (${mimeType}, ${sizeKb} KB)`,
              "",
              "Binary file downloaded. To save to Drive, call again with save_to_drive_folder_id.",
              "To find the right folder: crm_get_client_summary → drive_folder_id → drive_list_folder for subfolders.",
              "",
              `Attachment ID: ${attachment_id}`,
              `Filename: ${filename}`,
              `MIME Type: ${mimeType}`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Gmail attachment read failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
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
