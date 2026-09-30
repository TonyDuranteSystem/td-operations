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
 *    (resolved to whichever view hosts personal messages);
 *  - `topic`   — the tab, omitted for General.
 * Topic names are free text with spaces/accents/quotes — always encoded here.
 *
 * It points at `/portal/chat/open`, a route that saves the company to the
 * same cookies the company switcher writes and THEN redirects to the chat. The
 * company must be decided server-side before the portal renders: an earlier
 * version applied it in the browser after load, which left the sidebar showing
 * the old company, and a leftover ?account= overrode the client's next switch
 * (both caught in E2E QA).
 */

import type { PortalChatEntity } from '@/lib/portal/queries'

export const PERSONAL_CHAT_LINK = 'personal'
export const CHAT_LINK_MARKER = 'chatlink'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Cut to at most `max` characters without splitting an emoji / surrogate pair. */
function safeTopic(topic: string | null | undefined, max = 100): string {
  if (typeof topic !== 'string') return ''
  return Array.from(topic.trim()).slice(0, max).join('')
}

/**
 * On the login page: if the client arrived from a chat deep link while signed
 * out, where to send them after login (else null → the normal portal home).
 * Only a well-formed account value is carried; everything is re-encoded, and
 * the result is always a /portal/chat/open path on this site.
 */
export function chatLinkAfterLogin(search: string): string | null {
  const q = new URLSearchParams(search)
  if (q.get(CHAT_LINK_MARKER) !== '1') return null
  const account = q.get('account')
  if (account && account !== PERSONAL_CHAT_LINK && !UUID_RE.test(account)) return null
  return buildPortalChatLink({
    accountId: !account || account === PERSONAL_CHAT_LINK ? null : account,
    topic: safeTopic(q.get('topic')),
  })
}

/**
 * A chat deep link must be opened with a FULL page load (plain <a>), not a
 * client-side <Link>: the route sets the company cookie, and an in-app
 * navigation keeps the portal layout — so the sidebar would still show the
 * previous company.
 */
export function needsFullPageLoad(link: string): boolean {
  return link.startsWith('/portal/chat/open')
}

/** Relative portal path for a chat message's deep link. */
export function buildPortalChatLink(opts: { accountId?: string | null; topic?: string | null }): string {
  const params = new URLSearchParams()
  // Marker: a signed-out client is bounced to /portal/login with this query
  // intact (the path is dropped) — the login page uses it to send them on to
  // the linked chat instead of the portal home. See chatLinkAfterLogin.
  params.set(CHAT_LINK_MARKER, '1')
  params.set('account', opts.accountId ? opts.accountId : PERSONAL_CHAT_LINK)
  const topic = safeTopic(opts.topic)
  if (topic) params.set('topic', topic)
  // URLSearchParams encodes spaces as '+'; use %20 so the link reads the same
  // everywhere it is pasted (email href, push url, bell Link).
  return `/portal/chat/open?${params.toString().replace(/\+/g, '%20')}`
}

/** Where /portal/chat/open sends the client after saving the company. */
export function chatPathForTopic(topic: string | null | undefined): string {
  const t = safeTopic(topic)
  return t ? `/portal/chat?topic=${encodeURIComponent(t)}` : '/portal/chat'
}

export interface EntityCookieWrite {
  name: 'portal_account_id' | 'portal_formation' | 'portal_onboarding'
  value: string
  /** 0 = delete */
  maxAge: number
}

const ONE_YEAR = 31536000

/**
 * The cookie writes that select `e` — identical to the sidebar CompanySwitcher
 * (selectAccount / selectFormation) and the chat's own switch, so a link
 * leaves the portal in exactly the state a manual switch would.
 */
export function entityCookieWrites(e: PortalChatEntity): EntityCookieWrite[] {
  if (e.kind === 'formation') {
    return [
      { name: 'portal_formation', value: e.id, maxAge: ONE_YEAR },
      { name: 'portal_onboarding', value: '', maxAge: 0 },
    ]
  }
  return [
    { name: 'portal_account_id', value: e.kind === 'personal' ? PERSONAL_CHAT_LINK : (e.accountId as string), maxAge: ONE_YEAR },
    { name: 'portal_formation', value: '', maxAge: 0 },
    { name: 'portal_onboarding', value: '', maxAge: 0 },
  ]
}

/** Does this chat view show the contact's personal (company-less) messages? */
export function hostsPersonal(e: PortalChatEntity): boolean {
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

/**
 * The entity a chat link should leave SELECTED: the one it switches to, or —
 * when the link points at what is already selected — the current one. Null
 * when the link is unusable (not this client's, or no view hosts personal).
 * The /portal/chat/open route writes the switcher cookies for this entity
 * every time (idempotent), which also clears a stale onboarding selection that
 * would otherwise make the sidebar disagree with the chat.
 */
export function chatLinkTargetEntity(
  entities: PortalChatEntity[],
  accountParam: string | null | undefined,
  current: PortalChatEntity | undefined,
): PortalChatEntity | null {
  if (!accountParam) return null
  const linked = resolveChatEntityFromLink(entities, accountParam, current)
  if (linked) return linked
  if (!current) return null
  if (accountParam === PERSONAL_CHAT_LINK) return hostsPersonal(current) ? current : null
  return current.kind === 'company' && current.accountId === accountParam ? current : null
}
