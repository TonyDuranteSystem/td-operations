/**
 * Checkout redirect — get the client to the payment page, reliably.
 *
 * WHY THIS EXISTS (2026-07-14 incident, dev_task ba7bfd8d):
 * The portal shows the proposal inside a CROSS-ORIGIN IFRAME (app.tonydurante.us
 * framed by portal.tonydurante.us). Stripe Checkout REFUSES to render inside a
 * frame, so the old `window.location.href = checkoutUrl` navigated the FRAME to
 * Stripe and the client sat on Stripe's grey loading skeleton forever, unable to
 * pay. The proposal itself renders fine in the frame — only the pay CLICK broke,
 * which is why it survived every page-load test.
 *
 * WHY THE OBVIOUS FIX IS WRONG (caught in adversarial review):
 * "Just set window.top.location" does NOT reliably work here, and worse, it fails
 * SILENTLY. A cross-origin frame may navigate the top window only while it holds
 * transient user activation (~5s). The pay handler must first `await` a fetch that
 * creates a Stripe session (Supabase reads + a Stripe API round-trip), which can
 * outlive that window. When activation has lapsed browsers do NOT throw — they
 * ignore the assignment and log a console warning. A try/catch fallback therefore
 * never fires, and the Pay button is dead again: intermittently, and invisibly.
 *
 * THE FIX: open the tab SYNCHRONOUSLY, on the click itself, BEFORE the await —
 * while user activation is guaranteed. Point that already-open tab at Stripe once
 * the session URL arrives. If a popup blocker refused, fall back to a real link
 * the client clicks (a fresh click = fresh activation = always allowed).
 *
 * Rules: never navigate the frame itself to a payment provider, and never rely on
 * an exception to detect that a navigation was refused.
 */

/** What actually happened, so callers/tests can assert on it. */
export type CheckoutDelivery =
  | 'tab' //           the pre-opened tab was pointed at the payment page
  | 'top' //           not used today; reserved for a same-origin top drive
  | 'self' //          not framed; navigated normally
  | 'needs_manual' //  nothing could be opened — caller MUST render a link

/** Minimal structural window so this is unit-testable without a DOM. */
export interface CheckoutWindow {
  readonly self: unknown
  readonly top: { location: { href: string } } | null
  readonly location: { href: string }
  open?: (url: string, target: string, features?: string) => CheckoutTab | null
}

export interface CheckoutTab {
  location: { href: string }
  closed?: boolean
  opener?: unknown
  close?: () => void
}

/**
 * True when we're inside a frame. A cross-origin parent can make the comparison
 * throw; treat a throw as "framed", which is the safe assumption.
 */
export function isFramed(win: CheckoutWindow): boolean {
  try {
    return win.top !== win.self
  } catch {
    return true
  }
}

/**
 * Call this SYNCHRONOUSLY in the click handler, BEFORE any await.
 *
 * Opens a blank tab while the click's user activation is still live. Returns null
 * if a popup blocker refused — the caller then falls back to a manual link.
 *
 * Deliberately NOT `noopener`: that makes `window.open` return null and we would
 * lose the handle we need. `deliverCheckout` nulls out `opener` instead.
 */
export function openCheckoutTab(win: CheckoutWindow): CheckoutTab | null {
  if (typeof win.open !== 'function') return null
  try {
    return win.open('about:blank', '_blank') ?? null
  } catch {
    return null
  }
}

/**
 * Point the pre-opened tab at the payment page (or fall back).
 *
 *  1. The tab we opened on the click → always works, no activation needed.
 *  2. No tab and NOT framed → normal navigation (the direct proposal link).
 *  3. No tab and framed → try the top window, but ALSO tell the caller to render a
 *     manual link: a refused top navigation is silent, so we cannot detect it and
 *     must not pretend we succeeded.
 */
export function deliverCheckout(
  url: string,
  tab: CheckoutTab | null,
  win: CheckoutWindow,
): CheckoutDelivery {
  if (!url) throw new Error('deliverCheckout: url is required')

  if (tab && !tab.closed) {
    try {
      tab.opener = null
    } catch {
      /* not fatal */
    }
    tab.location.href = url
    return 'tab'
  }

  if (!isFramed(win)) {
    win.location.href = url
    return 'self'
  }

  try {
    if (win.top) win.top.location.href = url
  } catch {
    /* refused — the manual link covers it */
  }
  return 'needs_manual'
}

/** The session couldn't be created — don't strand a blank tab on the client. */
export function closeCheckoutTab(tab: CheckoutTab | null): void {
  try {
    tab?.close?.()
  } catch {
    /* already gone */
  }
}
