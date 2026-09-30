import type { InboxConversation } from '@/lib/types'

/**
 * The row the shell keeps as `selected` once staff open a conversation.
 *
 * Opening a thread marks it read, and the CRM records that itself — at the
 * moment of the click — instead of waiting for Gmail's label (or our index
 * copy of it) to catch up. The header's "Mark read / Mark unread" pill falls
 * back to `selected.unread` whenever the optimistic override has been released
 * (the override is dropped as soon as the server row moves off its baseline);
 * a snapshot still carrying the pre-open count made that fallback say "unread"
 * for an email that was already read, so the pill flipped to "Mark read" and
 * "Mark unread" was unreachable from it (Antonio, 2026-09-29).
 */
export function openedConversation(conversation: InboxConversation): InboxConversation {
  return conversation.unread === 0 ? conversation : { ...conversation, unread: 0 }
}
