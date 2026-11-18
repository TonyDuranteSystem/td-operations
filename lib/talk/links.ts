/**
 * The ONE shape of a link to a TD Talk / Team Chat message (Antonio, 2026-11-17: tapping a lock-screen alert opened the app but not the message —
 * the alert carried the chat but never the message). Every alert that is about ONE message builds its link here, so the message id is always in it.
 * The server builds `/team-chat?...` links for the CRM; the TD Talk service worker and the iPhone app turn them into `/talk?...` and keep the whole query
 * (lib/talk/paths.ts `talkUrlFor`, public/talk-sw.js, ios Routing.swift `AlertRouting.pagePath`).
 */
export function teamChatMessageUrl(p: { threadId: string; rootId?: string | null; messageId?: string | null }): string {
  const q = [`thread=${encodeURIComponent(p.threadId)}`]
  if (p.rootId) q.push(`root=${encodeURIComponent(p.rootId)}`)
  if (p.messageId) q.push(`message=${encodeURIComponent(p.messageId)}`)
  return `/team-chat?${q.join('&')}`
}
