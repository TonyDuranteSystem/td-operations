/**
 * Inbox worker — the SAME Slack worker (persona, knowledge, discuss-first
 * behavior, read-only WORKER_TOOLS + memory recall + propose_action),
 * embedded in the CRM Inbox. Antonio's request 2026-07-08: "I want the same
 * worker I have in Slack with the same power in inbox."
 *
 * Faithful-twin strategy: reuse SLACK_WORKER_SYSTEM_PROMPT verbatim and
 * append an addendum that overrides ONLY the surface-specific parts (Slack
 * formatting/channel semantics) and injects the email-thread context. The
 * Slack-only extra tools (send_portal_message, code-task rail) are NOT in
 * shared WORKER_TOOLS, so the R111 Antonio-only gating is preserved
 * structurally.
 */

import { SLACK_WORKER_SYSTEM_PROMPT } from "@/lib/ai-agent/slack-claude"

export interface InboxEmailContext {
  subject?: string
  sender?: string
  mailbox?: string
  /** Plain-text body of the latest message in the thread (caller-truncated) */
  latestMessage?: string
  /** Server-built plain-text transcript of the thread (preferred over latestMessage) */
  transcript?: string
  /** Gmail thread id + mailbox address so the worker can gmail_read_thread itself */
  gmailThreadId?: string
  mailboxAddress?: string
}

const SURFACE_ADDENDA = {
  inbox: `

━━━ SURFACE OVERRIDE — CRM INBOX (read this LAST, it wins over Slack-specific instructions above) ━━━
You are NOT in Slack right now. You are embedded in the CRM dashboard's Inbox, in a side panel next to an open email thread. The person talking to you is a staff member reading that email.
- FORMATTING: plain text with simple Markdown (short paragraphs, dashes for lists). No Slack mrkdwn, no <@mentions>, no channel references, no emoji reactions.
- Everything else about who you are, how you work, your tools, and your discuss-first discipline is UNCHANGED.
- Typical asks here: explain this email, check the client's real state in the CRM/DB before answering, recall past decisions from memory, draft a reply (give ONLY the email body text when asked for a draft — the staff member sends it themselves).
- You cannot send emails or messages from here. For actions, use propose_action as usual.`,
  'portal-chats': `

━━━ SURFACE OVERRIDE — PORTAL CHATS (read this LAST, it wins over Slack-specific instructions above) ━━━
You are NOT in Slack right now. You are embedded in the CRM dashboard's Portal Chats page, in a Worker tab for ONE specific client. The person talking to you is a staff member working that client.
- FORMATTING: plain text with simple Markdown (short paragraphs, dashes for lists). No Slack mrkdwn, no <@mentions>, no channel references, no emoji reactions.
- Everything else about who you are, how you work, your tools, and your discuss-first discipline is UNCHANGED.
- Typical asks here: summarize this client's state (services, payments, deadlines, chats, emails), recall past decisions from memory, draft a portal-chat message (give ONLY the message text when asked for a draft — the staff member sends it themselves).
- You cannot send messages from here. For actions, use propose_action as usual.`,
} as const

export type WorkerSurface = keyof typeof SURFACE_ADDENDA

/** System prompt for an embedded worker: Slack persona + surface override. */
export function buildWorkerSurfacePrompt(surface: WorkerSurface): string {
  return `${SLACK_WORKER_SYSTEM_PROMPT}${SURFACE_ADDENDA[surface]}`
}

/** Back-compat alias (inbox surface). */
export function buildInboxWorkerSystemPrompt(): string {
  return buildWorkerSurfacePrompt("inbox")
}

/** First-turn user body for the portal-chats Worker tab. */
export function buildClientWorkerUserBody(
  message: string,
  client?: { name?: string | null } | null
): string {
  if (!client?.name) return message
  return [
    `[PORTAL CHATS CONTEXT — the staff member is working the client: ${client.name}]`,
    "",
    `Staff member: ${message}`,
  ].join("\n")
}

/**
 * First-turn user body: prefix the email-thread context so the worker knows
 * what the staff member is looking at. Later turns pass the message through
 * (the thread context system carries the history).
 */
export function buildInboxWorkerUserBody(
  message: string,
  ctx?: InboxEmailContext | null
): string {
  if (!ctx) return message
  const lines = [
    "[CRM INBOX CONTEXT — the staff member is viewing this email thread. You have ALREADY read it below — do not say you cannot see the email.]",
    ctx.mailbox ? `Mailbox: ${ctx.mailbox}@` : "",
    ctx.sender ? `From: ${ctx.sender}` : "",
    ctx.subject ? `Subject: ${ctx.subject}` : "",
    ctx.gmailThreadId && ctx.mailboxAddress
      ? `Gmail thread id: ${ctx.gmailThreadId} (mailbox ${ctx.mailboxAddress}) — use gmail_read_thread with as_user="${ctx.mailboxAddress}" if you need more than the transcript below.`
      : "",
    ctx.transcript
      ? `THREAD TRANSCRIPT (plain text, oldest→newest, may be truncated):\n${ctx.transcript.slice(0, 12000)}`
      : ctx.latestMessage
        ? `Latest message (plain text, may be truncated):\n${ctx.latestMessage.slice(0, 6000)}`
        : "",
    "",
    `Staff member: ${message}`,
  ].filter((l) => l !== "")
  return lines.join("\n")
}
