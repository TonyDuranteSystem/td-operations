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
}): string {
  const statusLabel = TEAM_WORK_STATUS_LABELS[args.status as TeamWorkStatus] ?? args.status
  const lines: string[] = []
  lines.push(`Team Chat thread in #${args.channelLabel}: "${args.title}"`)
  lines.push(`Status: ${statusLabel}${args.assigneeName ? ` · Assigned to ${args.assigneeName}` : ''}`)
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

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(0, 16).replace('T', ' ')
}
