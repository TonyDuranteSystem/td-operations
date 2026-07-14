import { describe, it, expect, vi } from 'vitest'
import {
  isFramed,
  openCheckoutTab,
  deliverCheckout,
  closeCheckoutTab,
  type CheckoutWindow,
  type CheckoutTab,
} from '@/lib/payments/checkout-redirect'

const STRIPE_URL = 'https://checkout.stripe.com/c/pay/cs_live_abc123'

function makeTab(): CheckoutTab & { close: ReturnType<typeof vi.fn> } {
  return {
    location: { href: 'about:blank' },
    closed: false,
    opener: {},
    close: vi.fn(),
  } as CheckoutTab & { close: ReturnType<typeof vi.fn> }
}

/** Top-level window: top === self. */
function makeTopLevelWindow(tab: CheckoutTab | null = makeTab()) {
  const win = {
    location: { href: 'https://app.tonydurante.us/offer/t/c' },
    open: vi.fn(() => tab),
  } as unknown as CheckoutWindow & { location: { href: string }; open: ReturnType<typeof vi.fn> }
  Object.defineProperty(win, 'self', { value: win })
  Object.defineProperty(win, 'top', { value: win })
  return win
}

/** Framed window (the portal case): top !== self. */
function makeFramedWindow(tab: CheckoutTab | null = makeTab()) {
  const top = { location: { href: 'https://portal.tonydurante.us/portal/offer' } }
  const win = {
    location: { href: 'https://app.tonydurante.us/offer/t/c' },
    open: vi.fn(() => tab),
  } as unknown as CheckoutWindow & { location: { href: string }; open: ReturnType<typeof vi.fn> }
  Object.defineProperty(win, 'self', { value: win })
  Object.defineProperty(win, 'top', { value: top })
  return { win, top }
}

describe('isFramed', () => {
  it('false at top level, true inside a frame', () => {
    expect(isFramed(makeTopLevelWindow())).toBe(false)
    expect(isFramed(makeFramedWindow().win)).toBe(true)
  })
})

describe('openCheckoutTab', () => {
  it('opens a blank tab (so it happens on the click, before any await)', () => {
    const win = makeTopLevelWindow()
    const tab = openCheckoutTab(win)
    expect(win.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(tab).not.toBeNull()
  })

  it('returns null when a popup blocker refuses', () => {
    const win = makeTopLevelWindow(null)
    expect(openCheckoutTab(win)).toBeNull()
  })
})

describe('deliverCheckout', () => {
  // The whole point: Stripe must never be loaded INTO the portal's frame.
  it('sends the pre-opened tab to Stripe when framed — never the frame itself', () => {
    const tab = makeTab()
    const { win, top } = makeFramedWindow(tab)
    expect(deliverCheckout(STRIPE_URL, tab, win)).toBe('tab')
    expect(tab.location.href).toBe(STRIPE_URL)
    expect(win.location.href).not.toBe(STRIPE_URL) // the frame is untouched
    expect(top.location.href).not.toBe(STRIPE_URL)
  })

  it('drops the opener on the new tab', () => {
    const tab = makeTab()
    const { win } = makeFramedWindow(tab)
    deliverCheckout(STRIPE_URL, tab, win)
    expect(tab.opener).toBeNull()
  })

  it('navigates normally when NOT framed (the direct proposal link)', () => {
    const win = makeTopLevelWindow(null)
    expect(deliverCheckout(STRIPE_URL, null, win)).toBe('self')
    expect(win.location.href).toBe(STRIPE_URL)
  })

  // THE REGRESSION THIS FILE EXISTS FOR (found in adversarial review):
  // a cross-origin frame that has lost user activation cannot navigate the top
  // window, and the browser does NOT throw — it silently ignores the assignment.
  // Relying on a try/catch there left the Pay button dead with no error. So when
  // we are framed with no tab, we must ALWAYS tell the caller to render a link.
  it('demands a manual link when framed and the popup was blocked — never claims success', () => {
    const { win } = makeFramedWindow(null)
    expect(deliverCheckout(STRIPE_URL, null, win)).toBe('needs_manual')
  })

  it('still demands a manual link even if the top-window assignment appears to work', () => {
    // The assignment below "succeeds" in the mock, but a real browser may have
    // silently refused it — which is undetectable. So: needs_manual regardless.
    const { win, top } = makeFramedWindow(null)
    const result = deliverCheckout(STRIPE_URL, null, win)
    expect(top.location.href).toBe(STRIPE_URL)
    expect(result).toBe('needs_manual')
  })

  it('treats a closed tab as no tab', () => {
    const tab = makeTab()
    tab.closed = true
    const { win } = makeFramedWindow(tab)
    expect(deliverCheckout(STRIPE_URL, tab, win)).toBe('needs_manual')
    expect(tab.location.href).toBe('about:blank')
  })

  it('rejects an empty url', () => {
    const win = makeTopLevelWindow()
    expect(() => deliverCheckout('', null, win)).toThrow(/url is required/)
  })
})

describe('closeCheckoutTab', () => {
  it('closes the blank tab when the session could not be created', () => {
    const tab = makeTab()
    closeCheckoutTab(tab)
    expect(tab.close).toHaveBeenCalled()
  })

  it('is safe with no tab', () => {
    expect(() => closeCheckoutTab(null)).not.toThrow()
  })
})
