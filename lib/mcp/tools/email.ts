/**
 * Postmark Email MCP Tools
 * Send transactional emails with open/click tracking via Postmark.
 * Used by the Remote MCP server at /api/mcp.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

const POSTMARK_API = "https://api.postmarkapp.com"

async function postmark(endpoint: string, body: Record<string, unknown>) {
  const token = process.env.POSTMARK_SERVER_TOKEN
  if (!token) throw new Error("POSTMARK_SERVER_TOKEN not configured")

  const res = await fetch(`${POSTMARK_API}${endpoint}`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Postmark API error ${res.status}: ${(err as Record<string, string>).Message || res.statusText}`)
  }

  return res.json()
}

async function postmarkGet(endpoint: string) {
  const token = process.env.POSTMARK_SERVER_TOKEN
  if (!token) throw new Error("POSTMARK_SERVER_TOKEN not configured")

  const res = await fetch(`${POSTMARK_API}${endpoint}`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-Postmark-Server-Token": token,
    },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Postmark API error ${res.status}: ${(err as Record<string, string>).Message || res.statusText}`)
  }

  return res.json()
}

export function registerEmailTools(server: McpServer) {

  // ═══════════════════════════════════════
  // email_send
  // ═══════════════════════════════════════
  server.tool(
    "email_send",
    "Send a transactional email via Postmark from any @tonydurante.us address. Supports HTML body, CC/BCC, reply-to, and open/link tracking. Returns MessageID for tracking.",
    {
      from: z.string().optional().default("support@tonydurante.us").describe("Sender address (must be @tonydurante.us)"),
      to: z.string().describe("Recipient email address (or comma-separated for multiple)"),
      subject: z.string().describe("Email subject line"),
      body_html: z.string().optional().describe("HTML email body (supports rich formatting)"),
      body_text: z.string().optional().describe("Plain text email body (fallback if no HTML)"),
      cc: z.string().optional().describe("CC recipients (comma-separated)"),
      bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
      reply_to: z.string().optional().describe("Reply-To address (defaults to From)"),
      tag: z.string().optional().describe("Tag for categorizing emails (e.g. 'invoice', 'onboarding', 'support')"),
      track_opens: z.boolean().optional().default(true).describe("Track email opens (default: true)"),
      track_links: z.enum(["None", "HtmlAndText", "HtmlOnly", "TextOnly"]).optional().default("HtmlAndText").describe("Link click tracking mode"),
    },
    async ({ from, to, subject, body_html, body_text, cc, bcc, reply_to, tag, track_opens, track_links }) => {
      try {
        if (!body_html && !body_text) {
          return {
            content: [{ type: "text" as const, text: "❌ Error: Either body_html or body_text is required." }],
          }
        }

        const payload: Record<string, unknown> = {
          From: from || "support@tonydurante.us",
          To: to,
          Subject: subject,
          TrackOpens: track_opens ?? true,
          TrackLinks: track_links || "HtmlAndText",
        }

        if (body_html) payload.HtmlBody = body_html
        if (body_text) payload.TextBody = body_text
        if (cc) payload.Cc = cc
        if (bcc) payload.Bcc = bcc
        if (reply_to) payload.ReplyTo = reply_to
        if (tag) payload.Tag = tag

        // If only HTML provided, also generate a plain text version
        if (body_html && !body_text) {
          payload.TextBody = body_html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .trim()
        }

        const result = await postmark("/email", payload) as Record<string, unknown>

        return {
          content: [{
            type: "text" as const,
            text: [
              "✅ Email sent successfully via Postmark",
              "",
              `📧 To: ${to}`,
              `📋 Subject: ${subject}`,
              `🏷️ Tag: ${tag || "(none)"}`,
              `🔍 Tracking: opens=${track_opens ? "ON" : "OFF"}, links=${track_links}`,
              "",
              `📨 MessageID: ${result.MessageID}`,
              `📮 SubmittedAt: ${result.SubmittedAt}`,
              "",
              "Use email_get_delivery_status with the MessageID to check delivery and open status.",
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Email send failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // email_send_with_template
  // ═══════════════════════════════════════
  server.tool(
    "email_send_with_template",
    "Send an email using a Postmark template. Templates are pre-designed email layouts stored in Postmark. Pass template variables as key-value pairs.",
    {
      from: z.string().optional().default("support@tonydurante.us").describe("Sender address"),
      to: z.string().describe("Recipient email address"),
      template_alias: z.string().describe("Postmark template alias (e.g. 'welcome', 'invoice-reminder')"),
      template_model: z.record(z.string(), z.string()).optional().describe("Template variables as key-value pairs"),
      tag: z.string().optional().describe("Tag for categorizing"),
      track_opens: z.boolean().optional().default(true).describe("Track opens"),
    },
    async ({ from, to, template_alias, template_model, tag, track_opens }) => {
      try {
        const payload: Record<string, unknown> = {
          From: from || "support@tonydurante.us",
          To: to,
          TemplateAlias: template_alias,
          TemplateModel: template_model || {},
          TrackOpens: track_opens ?? true,
          TrackLinks: "HtmlAndText",
        }
        if (tag) payload.Tag = tag

        const result = await postmark("/email/withTemplate", payload) as Record<string, unknown>

        return {
          content: [{
            type: "text" as const,
            text: [
              "✅ Template email sent via Postmark",
              `📧 To: ${to}`,
              `📄 Template: ${template_alias}`,
              `📨 MessageID: ${result.MessageID}`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Template email failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // email_get_delivery_status
  // ═══════════════════════════════════════
  server.tool(
    "email_get_delivery_status",
    "Check delivery status of a sent email. Shows if the email was delivered, opened, clicked, or bounced. Use the MessageID returned by email_send.",
    {
      message_id: z.string().describe("Postmark MessageID (UUID format, returned by email_send)"),
    },
    async ({ message_id }) => {
      try {
        const result = await postmarkGet(`/messages/outbound/${message_id}/details`) as Record<string, unknown>

        const opens = await postmarkGet(`/messages/outbound/${message_id}/opens`) as Record<string, unknown[]>
        const clicks = await postmarkGet(`/messages/outbound/${message_id}/clicks`) as Record<string, unknown[]>

        const openCount = Array.isArray(opens?.Opens) ? opens.Opens.length : 0
        const clickCount = Array.isArray(clicks?.Clicks) ? clicks.Clicks.length : 0

        const statusEmoji = result.Status === "Sent" ? "✅" :
          result.Status === "Processed" ? "⏳" :
          result.Status === "Queued" ? "📤" : "❓"

        return {
          content: [{
            type: "text" as const,
            text: [
              `${statusEmoji} Email Status: ${result.Status}`,
              "",
              `📧 To: ${Array.isArray(result.To) ? (result.To as Array<{Email: string}>).map(t => t.Email).join(", ") : result.To}`,
              `📋 Subject: ${result.Subject}`,
              `🏷️ Tag: ${result.Tag || "(none)"}`,
              `📮 Sent: ${result.ReceivedAt}`,
              "",
              `👁️ Opens: ${openCount}`,
              `🔗 Clicks: ${clickCount}`,
              "",
              openCount > 0 ? `📖 First opened: ${(opens.Opens as Record<string, unknown>[])[0]?.ReceivedAt || "unknown"}` : "📭 Not yet opened",
              clickCount > 0 ? `🖱️ Links clicked: ${clickCount}` : "",
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Status check failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // email_search_activity
  // ═══════════════════════════════════════
  server.tool(
    "email_search_activity",
    "Search recent email activity. Find sent emails by recipient, subject, or tag. Shows delivery status, opens, and clicks for each message.",
    {
      recipient: z.string().optional().describe("Filter by recipient email address"),
      tag: z.string().optional().describe("Filter by tag (e.g. 'invoice', 'onboarding')"),
      subject: z.string().optional().describe("Filter by subject (partial match)"),
      count: z.number().optional().default(20).describe("Number of results (default 20, max 500)"),
    },
    async ({ recipient, tag, subject, count }) => {
      try {
        const params = new URLSearchParams()
        params.set("count", String(Math.min(count || 20, 500)))
        params.set("offset", "0")
        if (recipient) params.set("toEmail", recipient)
        if (tag) params.set("tag", tag)
        if (subject) params.set("subject", subject)

        const result = await postmarkGet(`/messages/outbound?${params.toString()}`) as {
          TotalCount: number
          Messages: Array<{
            MessageID: string
            To: Array<{ Email: string }>
            Subject: string
            Status: string
            Tag: string
            ReceivedAt: string
            Opens: Array<unknown>
          }>
        }

        if (!result.Messages || result.Messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "📭 No emails found matching the criteria." }],
          }
        }

        const lines = [
          `📊 Found ${result.TotalCount} emails (showing ${result.Messages.length})`,
          "",
        ]

        for (const msg of result.Messages) {
          const to = Array.isArray(msg.To) ? msg.To.map((t) => t.Email).join(", ") : String(msg.To)
          const statusEmoji = msg.Status === "Sent" ? "✅" : msg.Status === "Processed" ? "⏳" : "📤"
          const opened = msg.Opens && msg.Opens.length > 0 ? "👁️" : "📭"

          lines.push(`${statusEmoji} ${opened} ${msg.ReceivedAt} → ${to}`)
          lines.push(`   📋 ${msg.Subject}`)
          if (msg.Tag) lines.push(`   🏷️ ${msg.Tag}`)
          lines.push(`   📨 ID: ${msg.MessageID}`)
          lines.push("")
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Search failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // email_get_stats
  // ═══════════════════════════════════════
  server.tool(
    "email_get_stats",
    "Get email delivery statistics overview. Shows sent, delivered, opened, clicked, bounced counts for a date range.",
    {
      tag: z.string().optional().describe("Filter stats by tag"),
      from_date: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
      to_date: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today."),
    },
    async ({ tag, from_date, to_date }) => {
      try {
        const now = new Date()
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

        const params = new URLSearchParams()
        params.set("fromDate", from_date || thirtyDaysAgo.toISOString().split("T")[0])
        params.set("toDate", to_date || now.toISOString().split("T")[0])
        if (tag) params.set("tag", tag)

        const result = await postmarkGet(`/stats/outbound?${params.toString()}`) as Record<string, number>

        const openRate = result.Sent > 0
          ? ((result.Opens || 0) / result.Sent * 100).toFixed(1)
          : "N/A"

        const clickRate = result.Sent > 0
          ? ((result.Clicks || 0) / result.Sent * 100).toFixed(1)
          : "N/A"

        return {
          content: [{
            type: "text" as const,
            text: [
              "📊 Email Statistics" + (tag ? ` (tag: ${tag})` : ""),
              `📅 Period: ${params.get("fromDate")} → ${params.get("toDate")}`,
              "",
              `📨 Sent: ${result.Sent || 0}`,
              `✅ Delivered: ${result.Delivered || 0}`,
              `👁️ Opened: ${result.Opens || 0} (${openRate}%)`,
              `🔗 Clicked: ${result.Clicks || 0} (${clickRate}%)`,
              `🔄 Bounced: ${result.Bounced || 0}`,
              `🚫 Spam complaints: ${result.SpamComplaints || 0}`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Stats failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

}
