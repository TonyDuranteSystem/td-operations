import { describe, it, expect } from 'vitest'
import { t } from '@/lib/portal/i18n'
import {
  TOUR_MARKERS, DEFAULT_INVOICING_TOUR, DEFAULT_INVOICING_CHECKLIST, TourDefSchema, ChecklistDefSchema,
  validateTourDef, validateChecklistDef, resolveTourDef, resolveChecklistDef,
  parseTourPref, shouldOfferTour, nextStepIndex, TOUR_PREF_KEY_RE,
} from '@/lib/portal/guides/guides'

const hasKey = (key: string, lang: 'en' | 'it') => t(key, lang) !== key

describe('built-in defaults', () => {
  it('the default tour and checklist satisfy their own schema', () => {
    expect(TourDefSchema.safeParse(DEFAULT_INVOICING_TOUR).success).toBe(true)
    expect(ChecklistDefSchema.safeParse(DEFAULT_INVOICING_CHECKLIST).success).toBe(true)
  })
  it('every default step and item has wording in English AND Italian', () => {
    expect(validateTourDef(DEFAULT_INVOICING_TOUR, hasKey)).toEqual([])
    expect(validateChecklistDef(DEFAULT_INVOICING_CHECKLIST, hasKey)).toEqual([])
  })
  it('every default step points at a marker code owns', () => {
    for (const s of DEFAULT_INVOICING_TOUR.steps) expect(TOUR_MARKERS).toContain(s.target)
  })
})

describe('a catalog row can only point at things code owns', () => {
  const good = { id: 'invoicing', version: 2, steps: [{ id: 'a', target: 'tab-sales', titleKey: 'tour.invoicing.sales.title', bodyKey: 'tour.invoicing.sales.body' }] }
  it('a valid row replaces the default', () => {
    expect(resolveTourDef([{ metadata: good, status: 'active' }], hasKey).version).toBe(2)
  })
  it('an unknown marker, tab or malformed row falls back to the default (never throws)', () => {
    const bad = [
      { metadata: { ...good, steps: [{ ...good.steps[0], target: 'delete-everything' }] } },
      { metadata: { ...good, steps: [{ ...good.steps[0], tab: 'admin' }] } },
      { metadata: { ...good, steps: [] } },
      { metadata: 'garbage' },
      { metadata: null },
      { metadata: { ...good, steps: [good.steps[0], good.steps[0]] } },
    ]
    for (const row of bad) expect(resolveTourDef([row], hasKey)).toBe(DEFAULT_INVOICING_TOUR)
    expect(resolveTourDef([], hasKey)).toBe(DEFAULT_INVOICING_TOUR)
  })
  it('a row whose wording is missing in Italian is rejected, so a client never sees a raw key', () => {
    const missing = { ...good, steps: [{ ...good.steps[0], titleKey: 'tour.invoicing.does.not.exist' }] }
    expect(resolveTourDef([{ metadata: missing }], hasKey)).toBe(DEFAULT_INVOICING_TOUR)
    expect(validateTourDef(TourDefSchema.parse(missing), hasKey).length).toBeGreaterThan(0)
  })
  it('a draft or deprecated row is ignored; the next valid row wins', () => {
    expect(resolveTourDef([{ metadata: good, status: 'draft' }], hasKey)).toBe(DEFAULT_INVOICING_TOUR)
    expect(resolveTourDef([{ metadata: { ...good, version: 9 }, status: 'deprecated' }, { metadata: good, status: 'active' }], hasKey).version).toBe(2)
  })
  it('the checklist can only use rules code knows', () => {
    const ok = { id: 'invoicing', items: [{ id: 'p', rule: 'payment', required: true, labelKey: 'invoices.setup.payment' }] }
    const bad = { id: 'invoicing', items: [{ id: 'p', rule: 'run-sql', required: true, labelKey: 'invoices.setup.payment' }] }
    expect(resolveChecklistDef([{ metadata: ok }], hasKey).items).toHaveLength(1)
    expect(resolveChecklistDef([{ metadata: bad }], hasKey)).toBe(DEFAULT_INVOICING_CHECKLIST)
  })
})

describe('remembered state, per login', () => {
  const def = { version: 2 }
  it('offered when never seen', () => expect(shouldOfferTour(null, def)).toBe(true))
  it('not offered again after finishing the current version', () => expect(shouldOfferTour({ status: 'completed', version: 2 }, def)).toBe(false))
  it('offered again after finishing an OLDER version', () => expect(shouldOfferTour({ status: 'completed', version: 1 }, def)).toBe(true))
  it("never offered after 'don't show again', even for a newer version", () => {
    expect(shouldOfferTour({ status: 'dismissed', version: 1 }, def)).toBe(false)
    expect(shouldOfferTour({ status: 'dismissed', version: 0 }, { version: 50 })).toBe(false)
  })
  it('junk stored state is treated as never seen', () => {
    expect(parseTourPref({ status: 'weird', version: 1 })).toBeNull()
    expect(parseTourPref('x')).toBeNull()
    expect(parseTourPref({ status: 'completed', version: 3 })).toEqual({ status: 'completed', version: 3 })
    expect(shouldOfferTour(parseTourPref('x'), def)).toBe(true)
  })
  it('only tour.* keys are accepted', () => {
    expect(TOUR_PREF_KEY_RE.test('tour.invoicing')).toBe(true)
    for (const k of ['password', 'tour.', 'tour.A', 'x.tour.invoicing', 'tour.invoicing; drop', 'tour.' + 'a'.repeat(41)]) expect(TOUR_PREF_KEY_RE.test(k)).toBe(false)
  })
})

describe('skipping steps whose marker is not on screen', () => {
  const present = new Set([0, 2, 5])
  const isPresent = (i: number) => present.has(i)
  it('goes forward to the next present step', () => {
    expect(nextStepIndex(0, 1, 7, isPresent)).toBe(2)
    expect(nextStepIndex(2, 1, 7, isPresent)).toBe(5)
  })
  it('goes back to the previous present step', () => expect(nextStepIndex(5, -1, 7, isPresent)).toBe(2))
  it('returns null at the ends', () => {
    expect(nextStepIndex(5, 1, 7, isPresent)).toBeNull()
    expect(nextStepIndex(0, -1, 7, isPresent)).toBeNull()
  })
})
