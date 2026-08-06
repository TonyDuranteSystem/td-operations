import { describe, it, expect } from 'vitest'
import { parsePwaEventPayload, PWA_EVENT_VALUES } from '@/lib/portal/pwa-events'
import { derivePwaFunnel } from '@/lib/portal/pwa-stats'

describe('parsePwaEventPayload', () => {
  it('accepts every declared event bare', () => {
    for (const event of PWA_EVENT_VALUES) {
      expect(parsePwaEventPayload({ event })).toEqual({ event })
    }
  })

  it('accepts valid src and device', () => {
    expect(parsePwaEventPayload({ event: 'page_view', src: 'qr-print', device: 'android' }))
      .toEqual({ event: 'page_view', src: 'qr-print', device: 'android' })
  })

  it('rejects unknown event', () => {
    expect(parsePwaEventPayload({ event: 'uninstalled' })).toBeNull()
    expect(parsePwaEventPayload({ event: '' })).toBeNull()
  })

  it('rejects unknown src / device instead of storing attacker-shaped data', () => {
    expect(parsePwaEventPayload({ event: 'page_view', src: 'evil' })).toBeNull()
    expect(parsePwaEventPayload({ event: 'page_view', device: 'toaster' })).toBeNull()
    expect(parsePwaEventPayload({ event: 'page_view', src: 42 })).toBeNull()
  })

  it('rejects unknown fields entirely (no smuggled columns)', () => {
    expect(parsePwaEventPayload({ event: 'page_view', contact_id: 'x' })).toBeNull()
    expect(parsePwaEventPayload({ event: 'page_view', src: 'chat', extra: 1 })).toBeNull()
  })

  it('rejects non-objects', () => {
    expect(parsePwaEventPayload(null)).toBeNull()
    expect(parsePwaEventPayload('page_view')).toBeNull()
    expect(parsePwaEventPayload(['page_view'])).toBeNull()
    expect(parsePwaEventPayload(undefined)).toBeNull()
  })
})

describe('derivePwaFunnel', () => {
  it('empty input → zeroed funnel', () => {
    expect(derivePwaFunnel([])).toEqual({
      pageViews: 0,
      pageViewsBySrc: {},
      installsAndroid: 0,
      standaloneLaunches: 0,
      standaloneAuthenticated: 0,
    })
  })

  it('groups page views by src, null src bucketed as direct', () => {
    const funnel = derivePwaFunnel([
      { event: 'page_view', src: 'qr-desktop' },
      { event: 'page_view', src: 'qr-desktop' },
      { event: 'page_view', src: 'chat' },
      { event: 'page_view', src: null },
    ])
    expect(funnel.pageViews).toBe(4)
    expect(funnel.pageViewsBySrc).toEqual({ 'qr-desktop': 2, chat: 1, direct: 1 })
  })

  it('counts each funnel stage independently', () => {
    const funnel = derivePwaFunnel([
      { event: 'installed', src: 'qr-print' },
      { event: 'installed', src: null },
      { event: 'standalone_launch', src: null },
      { event: 'standalone_launch', src: null },
      { event: 'standalone_launch', src: null },
      { event: 'standalone_authenticated', src: null },
    ])
    expect(funnel.installsAndroid).toBe(2)
    expect(funnel.standaloneLaunches).toBe(3)
    expect(funnel.standaloneAuthenticated).toBe(1)
    expect(funnel.pageViews).toBe(0)
  })

  it('ignores unknown event rows (defensive against future enum widening)', () => {
    const funnel = derivePwaFunnel([{ event: 'mystery', src: null }])
    expect(funnel).toEqual({
      pageViews: 0,
      pageViewsBySrc: {},
      installsAndroid: 0,
      standaloneLaunches: 0,
      standaloneAuthenticated: 0,
    })
  })
})
