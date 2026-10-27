/**
 * Team Workspace — turn a thread link into plain text a Claude Code session
 * (or anything else) can read. Pure helpers only (R086) — the DB fetch lives
 * in the MCP tool that calls these.
 */

import { TEAM_WORK_STATUS_LABELS, type TeamWorkStatus } from '@/lib/team/workspace'

/**
 * A thread link looks like https://crm.tonydurante.us/team-chat?thread=<channel
 * id>&root=<root message id> — the same deep-link format the app already uses
 * internally (notifications, board cards, the Threads panel). Accepts a full
 * URL or a bare query string; rejects anything missing either id.
 */
export function parseThreadLink(link: string): { channelId: string; rootId: string } | { error: string } {
  const trimmed = (link ?? '').trim()
  if (!trimmed) return { error: 'No link provided.' }
  let params: URLSearchParams
  try {
    params = new URL(trimmed, 'https://crm.tonydurante.us').searchParams
  } catch {
    return { error: 'That does not look like a valid link.' }
  }
  const channelId = params.get('thread')
  const rootId = params.get('root')
  if (!channelId || !rootId) {
    return { error: 'That link is missing the thread — use "Copy link" from the thread\'s ⋯ menu in Team Chat, not the page URL.' }
  }
  return { channelId, rootId }
}

export interface ThreadReadoutMessage {
  sender_name: string | null
  created_at: string
  message: string | null
  deleted_at?: string | null
  attachments?: unknown[] | null
}

/**
 * Render a thread's content as plain text for an AI reader. Mirrors the
 * tombstone/attachment rules the UI already applies (thread-title.ts) so the
 * readout never leaks a soft-deleted body.
 */
export function formatThreadReadout(args: {
  channelLabel: string
  title: string
  status: TeamWorkStatus | string
  assigneeName: string | null
  messages: ThreadReadoutMessage[]
  /** Ids needed to ANSWER inside this thread (team_chat_send channel + root_id). */
  channelSlug?: string | null
  rootId?: string | null
}): string {
  const statusLabel = TEAM_WORK_STATUS_LABELS[args.status as TeamWorkStatus] ?? args.status
  const lines: string[] = []
  lines.push(`Team Chat thread in #${args.channelLabel}: "${args.title}"`)
  lines.push(`Status: ${statusLabel}${args.assigneeName ? ` · Assigned to ${args.assigneeName}` : ''}`)
  // Reading a bug is almost always the step before answering it, and the answer
  // belongs INSIDE the bug. Hand back the exact ids team_chat_send needs so the
  // reply cannot end up as a detached message in the channel.
  if (args.rootId) {
    lines.push(`To answer inside this thread: team_chat_send with channel="${args.channelSlug ?? args.channelLabel}" and root_id="${args.rootId}" (after Antonio approves the draft).`)
  }
  lines.push('')
  for (const m of args.messages) {
    const who = m.sender_name || 'Unknown'
    const when = formatTimestamp(m.created_at)
    if (m.deleted_at) {
      lines.push(`[${when}] ${who}: (message deleted)`)
      continue
    }
    const body = (m.message ?? '').trim()
    const attCount = m.attachments?.length ?? 0
    const attNote = attCount ? ` [${attCount} attachment${attCount > 1 ? 's' : ''}]` : ''
    lines.push(`[${when}] ${who}: ${body}${attNote}`)
  }
  return lines.join('\n')
}

/**
 * A TD Talk message link: https://crm.tonydurante.us/td-talk?thread=<chat id>&message=<message id> ("Copy link" in the
 * message menu). Works for direct messages, groups and channels. Returns null when the link carries no `message`.
 */
export function parseMessageLink(link: string): { threadId: string; messageId: string } | null {
  const trimmed = (link ?? '').trim()
  if (!trimmed) return null
  let params: URLSearchParams
  try { params = new URL(trimmed, 'https://crm.tonydurante.us').searchParams } catch { return null }
  const threadId = params.get('thread')
  const messageId = params.get('message')
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!threadId || !messageId || !uuid.test(threadId) || !uuid.test(messageId)) return null
  return { threadId, messageId }
}

export interface MessageReadoutAttachment { name?: string | null; url?: string | null; mime_type?: string | null; transcript?: { text?: string; english?: string | null } | null }
export interface MessageReadoutMessage extends Omit<ThreadReadoutMessage, 'attachments'> { id: string; attachments?: MessageReadoutAttachment[] | null }

/** Plain text of one linked message with the messages around it; the linked one is marked and its files are listed with their addresses. */
export function formatMessageReadout(args: { chatLabel: string; linkedId: string; messages: MessageReadoutMessage[] }): string {
  const lines: string[] = [`TD Talk chat: ${args.chatLabel}`, 'The message the link points at is marked ">>>"; the others are context.', '']
  for (const m of args.messages) {
    const mark = m.id === args.linkedId ? '>>> ' : '    '
    const who = m.sender_name || 'Unknown'
    const when = formatTimestamp(m.created_at)
    if (m.deleted_at) { lines.push(`${mark}[${when}] ${who}: (message deleted)`); continue }
    lines.push(`${mark}[${when}] ${who}: ${(m.message ?? '').trim()}`)
    for (const a of m.attachments ?? []) {
      lines.push(`${mark}    attachment: ${a.name || 'file'}${a.mime_type ? ` (${a.mime_type})` : ''} — ${a.url ?? 'no address'}`)
      const text = a.transcript?.english || a.transcript?.text
      if (text) lines.push(`${mark}    voice note text: ${text}`)
    }
  }
  return lines.join('\n')
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(0, 16).replace('T', ' ')
}
