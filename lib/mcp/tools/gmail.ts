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

let cachedGmailToken: { token: string; expiresAt: number } | null = null

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

const IMPERSONATE_EMAIL = () =>
  process.env.GOOGLE_IMPERSONATE_EMAIL || "support@tonydurante.us"

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1"

// ─── Token Management ───────────────────────────────────────

async function getGmailToken(): Promise<string> {
  if (cachedGmailToken && Date.now() < cachedGmailToken.expiresAt - 5 * 60 * 1000) {
    return cachedGmailToken.token
  }

  const creds = getCredentials()
  const now = Math.floor(Date.now() / 1000)

  const privateKey = await importPKCS8(creds.private_key, "RS256")
  const assertion = await new SignJWT({
    scope: GMAIL_SCOPES,
    sub: IMPERSONATE_EMAIL(),
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
  cachedGmailToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return data.access_token
}

// ─── API Helpers ────────────────────────────────────────────

async function gmailGet(endpoint: string, params?: Record<string, string>) {
  const token = await getGmailToken()
  const userEmail = IMPERSONATE_EMAIL()
  const url = new URL(`${GMAIL_API}/users/${userEmail}${endpoint}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
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

async function gmailPost(endpoint: string, body: Record<string, unknown>) {
  const token = await getGmailToken()
  const userEmail = IMPERSONATE_EMAIL()

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

function getHeader(headers: GmailHeader[], name: string): string {
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
    "Search emails in the support@tonydurante.us Gmail inbox. Uses Gmail search syntax: from:, to:, subject:, has:attachment, is:unread, after:, before:, label:. Returns message snippets with IDs for reading full content.",
    {
      query: z.string().describe("Gmail search query (e.g. 'from:client@example.com', 'subject:invoice is:unread', 'after:2026/01/01 has:attachment')"),
      max_results: z.number().optional().default(15).describe("Max results (default 15, max 50)"),
    },
    async ({ query, max_results }) => {
      try {
        const listResult = await gmailGet("/messages", {
          q: query,
          maxResults: String(Math.min(max_results || 15, 50)),
        }) as { messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }

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
            metadataHeaders: "From,To,Subject,Date",
          }) as GmailMessage

          const from = getHeader(detail.payload.headers, "From")
          const subject = getHeader(detail.payload.headers, "Subject")
          const date = getHeader(detail.payload.headers, "Date")
          const isUnread = detail.labelIds?.includes("UNREAD") ? "🔵" : "  "

          lines.push(`${isUnread} 📧 ${subject || "(no subject)"}`)
          lines.push(`   👤 ${from}`)
          lines.push(`   📅 ${date}`)
          lines.push(`   💬 ${detail.snippet}`)
          lines.push(`   🆔 ID: ${msg.id}`)
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
    "Read the full content of an email by its message ID (from gmail_search results). Returns subject, from, to, date, and body text.",
    {
      message_id: z.string().describe("Gmail message ID (from gmail_search results)"),
    },
    async ({ message_id }) => {
      try {
        const msg = await gmailGet(`/messages/${message_id}`, {
          format: "full",
        }) as GmailMessage

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
    "Read an entire email thread (conversation) by thread ID. Shows all messages in chronological order.",
    {
      thread_id: z.string().describe("Gmail thread ID (from gmail_search results)"),
    },
    async ({ thread_id }) => {
      try {
        const thread = await gmailGet(`/threads/${thread_id}`, {
          format: "full",
        }) as { id: string; messages: GmailMessage[] }

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
    "Create an email draft in the support@tonydurante.us mailbox. The draft can be reviewed and sent manually from Gmail. Does NOT send the email.",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC recipient(s)"),
      bcc: z.string().optional().describe("BCC recipient(s)"),
      reply_to_message_id: z.string().optional().describe("If replying, the original Gmail message ID to thread with"),
    },
    async ({ to, subject, body, cc, bcc, reply_to_message_id }) => {
      try {
        const fromEmail = IMPERSONATE_EMAIL()

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
          }) as GmailMessage

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

        const result = await gmailPost("/drafts", draftPayload) as {
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
  // gmail_labels
  // ═══════════════════════════════════════
  server.tool(
    "gmail_labels",
    "List all Gmail labels (folders/categories) for the support@tonydurante.us mailbox. Useful for understanding email organization.",
    {},
    async () => {
      try {
        const result = await gmailGet("/labels") as {
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
