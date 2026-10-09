/**
 * The slim "New: Customers & Invoices, take the 1-minute tour" strip at the top of the invoices page
 * (Antonio 2026-10-09, dev job 1a23f5f1).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { shouldShowTourBanner, shouldOfferTour, TOUR_EVENT_START, TOUR_EVENT_STATE } from '@/lib/portal/guides/guides'
import { t as translateKey } from '@/lib/portal/i18n'

const read = (p: string) => readFileSync(p, 'utf8')

describe('shouldShowTourBanner', () => {
  it('shows while the tour is still being offered and nothing has happened', () => {
    expect(shouldShowTourBanner({ offered: true, closedHere: false, state: null })).toBe(true)
  })
  it('never shows when the tour is not offered (finished, dismissed, or staff view-as)', () => {
    expect(shouldShowTourBanner({ offered: false, closedHere: false, state: null })).toBe(false)
  })
  it('goes away the moment the tour starts, finishes or is dismissed', () => {
    for (const state of ['started', 'finished', 'dismissed'] as const) {
      expect(shouldShowTourBanner({ offered: true, closedHere: false, state })).toBe(false)
    }
  })
  it('goes away when the person closes the banner', () => {
    expect(shouldShowTourBanner({ offered: true, closedHere: true, state: null })).toBe(false)
  })
  it('follows the same offer rule as the tour itself', () => {
    expect(shouldOfferTour(null, { version: 1 })).toBe(true)
    expect(shouldOfferTour({ status: 'completed', version: 1 }, { version: 1 })).toBe(false)
    expect(shouldOfferTour({ status: 'dismissed', version: 1 }, { version: 1 })).toBe(false)
  })
})

describe('wiring', () => {
  const page = read('app/portal/invoices/page.tsx')
  const tour = read('components/portal/guided-tour.tsx')
  const banner = read('components/portal/tour-banner.tsx')

  it('the page renders the banner only with the hub on, outside view-as, and while the tour is offered', () => {
    const m = /\{showHub && guides && !viewingAsClient && shouldOfferTour\(tourPref, guides\.tour\) && \(\s*<TourBanner/.exec(page)
    expect(m).not.toBeNull()
  })
  it('the banner is the first thing in the page (above the header)', () => {
    expect(page.indexOf('<TourBanner')).toBeGreaterThan(-1)
    expect(page.indexOf('<TourBanner')).toBeLessThan(page.indexOf('{/* Header */}'))
  })
  it('the banner button asks the SAME tour to start, and the tour announces its state back', () => {
    expect(banner).toContain('TOUR_EVENT_START')
    expect(tour).toContain('TOUR_EVENT_START')
    expect(tour).toContain("announce('started')")
    expect(tour).toContain("announce('finished')")
    expect(tour).toContain("announce('dismissed')")
    expect(TOUR_EVENT_START).not.toBe(TOUR_EVENT_STATE)
  })
  it('it is green, one line, and only pulses when the device allows motion', () => {
    expect(banner).toContain('emerald')
    expect(banner).toContain('motion-safe:animate-pulse')
    expect(banner).toContain('truncate')
  })
  it('the words exist in English and Italian and never speak as Tony Durante', () => {
    for (const lang of ['en', 'it'] as const) {
      for (const key of ['tour.invoicing.bannerText', 'tour.invoicing.bannerClose']) {
        const v = translateKey(key, lang)
        expect(v, `${key} ${lang}`).not.toBe(key)
        expect(v).not.toMatch(/\b(we|us|our|noi|nostro)\b/i)
      }
    }
    expect(translateKey('tour.invoicing.bannerText', 'en')).toBe('New: Customers & Invoices. Take the 1-minute tour.')
  })
})
