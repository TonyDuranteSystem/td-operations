/**
 * TD Communication — pure helpers (no DB / no I/O).
 *
 * These hold the validation + shaping logic so it is unit-testable without a
 * database (R086). The DB layer (queries.ts) and the API routes call into
 * these for every write.
 */

import type { CommMessage, CommPartyType } from './types'

export const MAX_MESSAGE_LENGTH = 8000
export const TD_COMMUNICATION_SCOPE = 'td_communication'

export interface MessageValidation {
  /** Trimmed body when valid, else null. */
  body: string | null
  /** Error message when invalid (surfaced to the user per R099), else null. */
  error: string | null
}

/**
 * Normalize + validate a message body. Returns the trimmed body, or an error
 * string explaining why it was rejected (surfaced to the user per R099). Both
 * fields are always present (one is null) so callers don't depend on union
 * narrowing.
 */
export function validateMessageBody(raw: unknown): MessageValidation {
  if (typeof raw !== 'string') {
    return { body: null, error: 'Message body is required.' }
  }
  const body = raw.trim()
  if (body.length === 0) {
    return { body: null, error: 'Cannot send an empty message.' }
  }
  if (body.length > MAX_MESSAGE_LENGTH) {
    return {
      body: null,
      error: `Message is too long (${body.length} characters, max ${MAX_MESSAGE_LENGTH}).`,
    }
  }
  return { body, error: null }
}

/**
 * Whether a partner's scope array grants access to the TD Communication surface.
 * Tolerant of null/undefined/non-array inputs (default-deny).
 */
export function partnerHasCommScope(scope: unknown): boolean {
  return Array.isArray(scope) && scope.includes(TD_COMMUNICATION_SCOPE)
}

/**
 * Short single-line preview of a message body for conversation-list rows.
 * Soft-deleted messages never leak their body (R100) — they show a placeholder.
 */
export function messagePreview(
  message: Pick<CommMessage, 'body' | 'deleted_at'> | null | undefined,
  maxLen = 80,
): string | null {
  if (!message) return null
  if (message.deleted_at) return 'Message deleted'
  const oneLine = message.body.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxLen) return oneLine
  return oneLine.slice(0, maxLen - 1).trimEnd() + '…'
}

/**
 * Is this message owned by the given viewer? Drives left/right bubble alignment.
 * A message is "own" when its sender type AND id both match the viewer.
 */
export function isOwnMessage(
  message: Pick<CommMessage, 'sender_type' | 'sender_id'>,
  viewerType: CommPartyType,
  viewerId: string,
): boolean {
  return message.sender_type === viewerType && message.sender_id === viewerId
}

/** Normalize an optional subject: trimmed, or null when empty. */
export function normalizeSubject(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return s.length === 0 ? null : s.slice(0, 200)
}
