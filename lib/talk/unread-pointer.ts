/**
 * "Mark unread" for a chat that keeps one read position per person (TD Marketing's lead chats and team chats; pure). The position moves back to just before the chosen message, so that message
 * and everything newer from others counts as unread again for ME. It never moves forward: if older messages are already unread, they stay unread. Times are ISO strings.
 */
export function pointerBefore(messageCreatedAt: string, currentLastReadAt: string | null): string {
  const t = new Date(messageCreatedAt).getTime()
  const before = new Date((Number.isFinite(t) ? t : Date.now()) - 1).toISOString()
  if (currentLastReadAt && new Date(currentLastReadAt).getTime() < new Date(before).getTime()) return currentLastReadAt
  return before
}
