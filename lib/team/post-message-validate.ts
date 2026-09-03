/**
 * Pure validators for posting into Team Chat (shared by the server choke-point
 * lib/team/post-message.ts and its unit tests). No server-only imports so it is
 * safe to unit-test / import anywhere.
 */
import { validateTeamCard } from '@/lib/team/workspace'
import type { ChatAttachment } from '@/lib/types'

export const TEAM_MESSAGE_MAX = 5000

/**
 * Validate the target selector: exactly one of channel / thread_id / dm_user_id.
 * Returns an error string or null.
 */
export function validateTeamPostTarget(input: {
  channel?: string | null
  thread_id?: string | null
  dm_user_id?: string | null
  root_id?: string | null
}): string | null {
  const set = [input.channel, input.thread_id, input.dm_user_id].filter(
    (v) => typeof v === 'string' && v.trim().length > 0,
  )
  if (set.length === 0) return 'A target is required: one of channel, thread_id, or dm_user_id.'
  if (set.length > 1) return 'Provide exactly ONE target: channel, thread_id, or dm_user_id (not several).'
  // A DM is a flat conversation with no threads inside it, so "answer inside
  // thread X" has no meaning there. Refuse loudly rather than silently dropping
  // the root and posting into the DM as a new message.
  const root = typeof input.root_id === 'string' ? input.root_id.trim() : ''
  if (root && typeof input.dm_user_id === 'string' && input.dm_user_id.trim()) {
    return 'root_id cannot be combined with dm_user_id — a direct message has no threads inside it.'
  }
  return null
}

/**
 * Validate the message body + optional card. Returns an error or null.
 */
export function validateTeamPostMessage(message: string, card?: unknown): string | null {
  const m = (message ?? '').toString().trim()
  if (!m) return 'message is required.'
  if (m.length > TEAM_MESSAGE_MAX) return `Message too long (max ${TEAM_MESSAGE_MAX} characters).`
  const cardErr = validateTeamCard(card ?? null)
  if (cardErr) return cardErr
  return null
}

/**
 * Validate optional attachments. Mirrors the human send route's own guard
 * (app/api/team/threads/[id]/messages/route.ts): every attachment must live
 * on our own Storage host — never an arbitrary off-site URL — plus a name.
 * `allowedUrlPrefix` is passed in (never read from env here) so this stays a
 * pure, unit-testable function like its siblings above.
 */
export function validateTeamPostAttachments(
  attachments: ChatAttachment[] | null | undefined,
  allowedUrlPrefix: string,
): string | null {
  if (!attachments || attachments.length === 0) return null
  for (const a of attachments) {
    const url = (a?.url ?? '').toString().trim()
    if (!url) return 'Each attachment needs a url.'
    if (allowedUrlPrefix && !url.startsWith(allowedUrlPrefix)) {
      return 'Invalid attachment URL — must be hosted on our own Storage.'
    }
    if (!a?.name) return 'Each attachment needs a name.'
  }
  return null
}
