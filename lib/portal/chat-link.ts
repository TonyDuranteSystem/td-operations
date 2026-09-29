/**
 * Deep links into the client portal chat (dev job 05d997f2).
 *
 * A "new message" email / bell entry used to link to plain `/portal/chat`. The
 * chat then opened on whichever company the client last looked at, on the
 * General tab — so a message sent to another company, or filed under a topic
 * tab (signature reminders, "Tax Return 2026", …), was not on the screen the
 * link opened. The client saw the email, opened the portal, found nothing, and
 * the message "appeared hours later" when they stumbled on the right tab
 * (William Canzi, 2026-09-28).
 *
 * The link therefore carries BOTH:
 *  - `account` — the company id, or `personal` for a message with no company
 *    (resolved by the chat page to whichever view hosts personal messages);
 *  - `topic`   — the tab, omitted for General.
 * Topic names are free text with spaces/accents/quotes — always encoded here.
 */

import type { PortalChatEntity } from '@/lib/portal/queries'

export const PERSONAL_CHAT_LINK = 'personal'

/** Relative portal path for a chat message's deep link. */
export function buildPortalChatLink(opts: { accountId?: string | null; topic?: string | null }): string {
  const params = new URLSearchParams()
  params.set('account', opts.accountId ? opts.accountId : PERSONAL_CHAT_LINK)
  const topic = typeof opts.topic === 'string' ? opts.topic.trim() : ''
  if (topic) params.set('topic', topic)
  // URLSearchParams encodes spaces as '+'; use %20 so the link reads the same
  // everywhere it is pasted (email href, push url, bell Link).
  return `/portal/chat?${params.toString().replace(/\+/g, '%20')}`
}

/** Does this chat view show the contact's personal (company-less) messages? */
function hostsPersonal(e: PortalChatEntity): boolean {
  return e.kind === 'personal' || e.kind === 'formation' || e.includePersonalNull
}

/**
 * Resolve the `?account=` of a chat deep link to the entity to open.
 * Returns null when the link says nothing usable (absent, unknown id, not one of
 * this client's entities) or when the currently selected entity already shows
 * the linked messages — the caller then keeps its normal cookie selection.
 */
export function resolveChatEntityFromLink(
  entities: PortalChatEntity[],
  accountParam: string | null | undefined,
  currentlySelected: PortalChatEntity | undefined,
): PortalChatEntity | null {
  if (!accountParam) return null
  if (accountParam === PERSONAL_CHAT_LINK) {
    if (currentlySelected && hostsPersonal(currentlySelected)) return null
    return (
      entities.find(e => e.kind === 'personal') ??
      entities.find(e => e.kind === 'company' && e.includePersonalNull) ??
      entities.find(e => e.kind === 'formation') ??
      null
    )
  }
  const match = entities.find(e => e.kind === 'company' && e.accountId === accountParam)
  if (!match || match === currentlySelected) return null
  return match
}
