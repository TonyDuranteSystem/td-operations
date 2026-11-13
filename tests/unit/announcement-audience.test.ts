import { describe, it, expect } from 'vitest'
import { visibleOnWebsite } from '@/lib/portal/announcement-audience'

// An announcement limited to the client iPhone app (app_only) must never be drawn by the website's portal home (dev job 056a70d0).

describe('visibleOnWebsite', () => {
  const a = { id: 'a', app_only: false }
  const b = { id: 'b', app_only: true }
  const c = { id: 'c' }
  const d = { id: 'd', app_only: null }

  it('drops the announcements that are limited to the app', () => {
    expect(visibleOnWebsite([a, b]).map(x => x.id)).toEqual(['a'])
  })

  it('keeps every announcement that does not say app-only: false, missing and null all mean "everywhere"', () => {
    expect(visibleOnWebsite([a, c, d]).map(x => x.id)).toEqual(['a', 'c', 'd'])
  })

  it('keeps the order, and an all-app-only list becomes empty', () => {
    expect(visibleOnWebsite([c, b, a]).map(x => x.id)).toEqual(['c', 'a'])
    expect(visibleOnWebsite([b])).toEqual([])
    expect(visibleOnWebsite([])).toEqual([])
  })

  it('does not change the list it is given (the app still reads the full list)', () => {
    const all = [a, b]
    visibleOnWebsite(all)
    expect(all).toHaveLength(2)
  })
})
