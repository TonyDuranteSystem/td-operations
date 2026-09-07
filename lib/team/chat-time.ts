/**
 * Team Workspace — shared message-timestamp formatting.
 *
 * Extracted from the full Team Chat page (council review, 2026-09-07): the page
 * had its own private copy and the floating chat widget had none at all. This
 * codebase has already been burned once by two chat surfaces silently drifting
 * on the same kind of string (DELETED_MESSAGE_TEXT) — ONE source here so the
 * page and the widget can never show two different clocks for the same message.
 */
import { format, isToday, isYesterday } from 'date-fns'

/**
 * Format a message's `created_at` for display: today → "HH:mm", yesterday →
 * "Yesterday HH:mm", else → "MMM d, HH:mm". Empty/invalid input renders as ''
 * rather than throwing — the widget's own `ChatMessage.created_at` is typed
 * nullable, unlike the full page's stricter type.
 */
export function msgTime(ts: string | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  if (isToday(d)) return format(d, 'HH:mm')
  if (isYesterday(d)) return `Yesterday ${format(d, 'HH:mm')}`
  return format(d, 'MMM d, HH:mm')
}
