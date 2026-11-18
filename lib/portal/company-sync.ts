/**
 * Live company sync between open portal tabs and the apps (dev job 58cb7a82).
 *
 * The portal saves the selected company ONCE for the whole browser (three cookies), not once per tab. Before this, a second
 * tab kept showing the old company until it reloaded, and after an in-app link it showed the new company's page under the OLD
 * company's name at the top (Antonio: "the portal must refresh immediately").
 *
 * The rule, kept pure here so it is unit-tested:
 *  - every tab remembers the saved company as it was when the tab last drew itself (its "signature");
 *  - when a tab changes company it announces it through localStorage, which the browser delivers to every OTHER tab at once;
 *  - a tab that hears it (or comes back to the front) compares the saved company with its own signature and, if they differ,
 *    refreshes itself and tells the person in one line.
 * Comparing against the tab's own signature (not against "what the company should be") means a stale or invalid cookie can
 * never make a tab refresh in a loop: only a real change does.
 */

/** The cookies that select the company (written by the company chip and by chat links; read by the portal layout). */
export const COMPANY_COOKIE_NAMES = ['portal_account_id', 'portal_formation', 'portal_onboarding'] as const

/** The localStorage key a tab writes to tell the other tabs that the company changed. */
export const COMPANY_SYNC_STORAGE_KEY = 'td_portal_company_sync'

/** The saved company as one comparable string, read from a `document.cookie`-style string. */
export function companySignature(cookieString: string): string {
  const jar = new Map<string, string>()
  for (const part of (cookieString || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    if (!name) continue
    let value = part.slice(i + 1).trim()
    try { value = decodeURIComponent(value) } catch { /* keep the raw value */ }
    if (!jar.has(name)) jar.set(name, value)
  }
  return COMPANY_COOKIE_NAMES.map(n => jar.get(n) ?? '').join('|')
}

/** True when the saved company is no longer the one this tab drew. */
export function companyChangedElsewhere(renderedSignature: string, currentSignature: string): boolean {
  return renderedSignature !== currentSignature
}

/** How long a change this tab made itself counts as "its own" (its refresh lands well inside this). */
export const OWN_CHANGE_WINDOW_MS = 8000

/** The saved company this tab itself just announced, and when; its own refresh is already on its way, so it must not "catch up" on it. */
let announcedHere: { signature: string; at: number } | null = null

/** True when `signature` is the change this tab itself made a moment ago. */
export function wasAnnouncedHere(signature: string, now: number = Date.now()): boolean {
  return announcedHere !== null && announcedHere.signature === signature && now - announcedHere.at < OWN_CHANGE_WINDOW_MS
}

/**
 * Tell the other open tabs that the company just changed. Call it right AFTER the cookies are written. Every call carries a
 * fresh stamp, because the browser only raises the event in other tabs when the stored value really changes.
 */
export function announceCompanyChange(): void {
  const signature = companySignature(document.cookie)
  announcedHere = { signature, at: Date.now() }
  try {
    localStorage.setItem(COMPANY_SYNC_STORAGE_KEY, `${signature}@${Date.now()}`)
  } catch {
    /* storage blocked: the tab-comes-to-front check still keeps the other tabs right */
  }
}
