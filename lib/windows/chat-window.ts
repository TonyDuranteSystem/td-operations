/**
 * Where a person's or a company's chat opens as a floating window (Antonio 2026-11-16: "open the portal chat for that specific client in a
 * floating window" — from the small chat icon in the Contacts and Accounts lists and the Message button on the Contact page, see
 * components/contacts/message-contact-button.tsx). The window shows the ordinary Portal Chats page — with all its tools (emoji, scan/photo
 * attach, AI polish and suggestions, voice notes, To-Do, Worker …) — already on that client's thread: Portal Chats reads `account` /
 * `contact` from the address. Pure and client-safe so the address and the title are unit-tested (R086).
 */

export function chatWindowHref(target: { contactId?: string | null; accountId?: string | null }): string {
  if (target.accountId) return `/portal-chats?account=${encodeURIComponent(target.accountId)}`
  if (target.contactId) return `/portal-chats?contact=${encodeURIComponent(target.contactId)}`
  return '/portal-chats'
}

/** The window's title: "Chat — Name", so several open windows can be told apart. */
export function chatWindowTitle(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  return n ? `Chat — ${n}` : 'Chat'
}
