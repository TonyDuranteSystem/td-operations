/**
 * Links that ARE the credential — and who must not read them in the portal chat.
 *
 * Several public pages open with nothing but a link that carries its own secret (a token and an access code in the path): the member
 * information form, the add-a-contact form, the operating-agreement and SS-4 signing pages, leases, offers, the tax / formation /
 * onboarding / banking / closure / ITIN forms, e-sign pages. Whoever holds the link can use the page — no login. Staff sometimes paste
 * such a link into a client's chat, and a company chat is read by every owner and member AND by every team login with the Chat tick.
 * A team login is not allowed to sign, to generate documents or to change the owners (the locked powers), but with the link it could do
 * all three through the public page.
 *
 * So: a team login sees a neutral line where such a link sits. Owners, members and TD staff are not affected (an owner needs the link —
 * that is what it is for). It covers every message, old ones included, and every sender, so a new flow that pastes a link needs nothing.
 *
 * Login-protected portal pages (`/portal/sign/...`, `/portal/chat/open...`, invoices, …) are NOT credential links and are left alone.
 *
 * The page list below is checked against the middleware's public-prefix list by `tests/unit/credential-links.test.ts`, so a new public
 * token page cannot be added without deciding whether its link belongs here.
 *
 * Regex LITERALS on purpose (R115): the production build can change a RegExp that is made from a template string.
 */

/** Public pages whose link carries its own secret, written as they appear in the first path segment(s) after the host. */
export const CREDENTIAL_LINK_PAGES = [
  'member-info', 'contact-request', 'operating-agreement', 'ss4', 'lease', 'offer', 'tax-form', 'formation-form', 'onboarding-form',
  'banking-form', 'closure-form', 'itin-form', 'tax-quote', 'sign-document', 'sign', 'invitation', 'bank-application', 'contract-template',
  'welcome', 'pay', 'r', 'portal/form',
] as const

// https://<host>/<page>/<something of at least 4 characters>  — the host is required, so "/portal/sign/…" (a login page) never matches "/sign/…".
const PAGE_LINK = /https?:\/\/[^\s/<>"')\]]+\/(?:member-info|contact-request|operating-agreement|ss4|lease|offer|tax-form|formation-form|onboarding-form|banking-form|closure-form|itin-form|tax-quote|sign-document|sign|invitation|bank-application|contract-template|welcome|pay|r|portal\/form)\/[A-Za-z0-9._~%@-]{4,}/i
// The legacy offer host: offerte.<domain>/<token>
const LEGACY_OFFER_LINK = /https?:\/\/offerte\.[^\s/<>"')\]]+\/[A-Za-z0-9._~%@-]{4,}/i

export const HIDDEN_LINK_NOTICE = "A secure link was sent to the company's owner. It is not shown here."

/** True when the text holds a link that works without a login. */
export function holdsCredentialLink(text: string | null | undefined): boolean {
  if (!text) return false
  return PAGE_LINK.test(text) || LEGACY_OFFER_LINK.test(text)
}

/**
 * What a team login is shown instead of a message that holds a credential link: the same message with its text (and the saved
 * original text of an edited message) replaced by a neutral line. Everything else on the row — sender, time, topic — stays.
 * Rows without such a link are returned untouched (same object).
 */
export function hideCredentialLinks<T extends { message?: string | null; original_message?: string | null }>(rows: T[]): T[] {
  return rows.map((row) => {
    const hideMessage = holdsCredentialLink(row.message)
    const hideOriginal = holdsCredentialLink(row.original_message)
    if (!hideMessage && !hideOriginal) return row
    return {
      ...row,
      ...(hideMessage ? { message: HIDDEN_LINK_NOTICE } : {}),
      ...(hideOriginal ? { original_message: HIDDEN_LINK_NOTICE } : {}),
    }
  })
}
