import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClosureBanner } from '@/components/portal/closure-banner'

/**
 * A contract that closes two companies gives the client two closure forms, each its own card on the portal home
 * (dev job 9829a468). The cards are numbered so they can be told apart; a single card is unchanged.
 */
const closure = { serviceDeliveryId: 'sd-1', accountId: null, companyName: null }
const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ClosureBanner as never, { closure, locale: 'en', ...props }))

describe('ClosureBanner numbering', () => {
  it('a single closure form keeps its plain title', () => {
    expect(html({})).toContain('Complete Registration — Company Closure<')
    expect(html({ position: { index: 1, total: 1 } })).not.toContain('(1 of')
  })
  it('several forms: "(1 of 2)" in English, "(1 di 2)" in Italian', () => {
    expect(html({ position: { index: 1, total: 2 } })).toContain('Complete Registration — Company Closure (1 of 2)')
    expect(html({ locale: 'it', position: { index: 2, total: 2 } })).toContain('Completa Registrazione — Chiusura Società (2 di 2)')
  })
  it('every card opens ITS OWN job (the wizard takes the job id)', () => {
    expect(html({ closure: { ...closure, serviceDeliveryId: 'abc-123' } })).toContain('/portal/wizard?type=closure&amp;sd=abc-123')
  })
  it('the portal home numbers every card it draws, on both home-page branches', () => {
    const src = readFileSync(join(process.cwd(), 'app/portal/page.tsx'), 'utf8')
    const calls = src.match(/position=\{\{ index: i \+ 1, total: pendingClosures\.length \}\}/g) ?? []
    expect(calls).toHaveLength(2)
  })
})
