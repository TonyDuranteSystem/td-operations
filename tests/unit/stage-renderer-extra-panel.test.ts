/**
 * The step renderer puts a panel the PAGE hands it (`extraPanel`) in the right place among the step's own panels
 * (dev job bf9886a3, bug-hunter pass 2026-11-17: the placement was only covered as a pure function, never rendered).
 * Real components, rendered to HTML on the server. The panels used are plain "waiting notice" boxes, told apart by their text, plus the
 * real SS-4 correction panel (it prints "Loading…" until its browser-side read finishes).
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StageRenderer } from '@/components/flows/stage-renderer'
import { parseStageLayout } from '@/lib/flows/stage-layout'

const sd = {
  id: 'job-1', service_type: 'Company Formation', stage: 'SS-4 Sent to IRS', stage_order: 7, status: 'active', assigned_to: null, due_date: null,
  stage_entered_at: null, account_id: 'acct-1', contact_id: 'c-1', contact_name: 'Buyer', current_client_label: null, formation_filed_name: null,
  shipping_courier: null, shipping_tracking_number: null, shipping_submitted_at: null,
}
const account = { id: 'acct-1', company_name: 'Novag LLC', state_of_formation: 'Wyoming', annual_report_due_date: null, ra_renewal_date: null, ein_number: null, registered_agent_address: null, mailing_address: null }

function render(components: unknown[], extra: boolean) {
  const layout = parseStageLayout({ components })
  const extraPanel = extra ? createElement('div', { 'data-extra': 'yes' }, 'EXTRA-PANEL') : undefined
  return renderToStaticMarkup(createElement(StageRenderer, { layout, serviceDelivery: sd as never, account: account as never, extraPanel }))
}
const wait = (label: string) => ({ type: 'waiting_notice', label })
const at = (html: string, text: string) => html.indexOf(text)

describe('where the extra panel is drawn', () => {
  it('is not drawn when the page hands none', () => {
    const html = render([wait('FIRST'), wait('SECOND')], false)
    expect(html).not.toContain('EXTRA-PANEL')
    expect(at(html, 'FIRST')).toBeLessThan(at(html, 'SECOND'))
  })

  it('goes straight after the SS-4 correction panel, before the panels that follow it', () => {
    const html = render([wait('BEFORE'), { type: 'ss4_correction_panel' }, wait('AFTER')], true)
    expect(html.match(/EXTRA-PANEL/g)).toHaveLength(1)
    expect(at(html, 'BEFORE')).toBeLessThan(at(html, 'Loading'))
    expect(at(html, 'Loading')).toBeLessThan(at(html, 'EXTRA-PANEL'))
    expect(at(html, 'EXTRA-PANEL')).toBeLessThan(at(html, 'AFTER'))
  })

  it('goes at the end, once, when the step has neither the correction panel nor the chat', () => {
    const html = render([wait('FIRST'), wait('SECOND')], true)
    expect(html.match(/EXTRA-PANEL/g)).toHaveLength(1)
    expect(at(html, 'SECOND')).toBeLessThan(at(html, 'EXTRA-PANEL'))
  })

  it('goes at the end, once, when the correction panel is the last one', () => {
    const html = render([wait('FIRST'), { type: 'ss4_correction_panel' }], true)
    expect(html.match(/EXTRA-PANEL/g)).toHaveLength(1)
    expect(at(html, 'Loading')).toBeLessThan(at(html, 'EXTRA-PANEL'))
  })

  it('is still drawn once on a step with no layout at all', () => {
    const html = renderToStaticMarkup(createElement(StageRenderer, { layout: null, serviceDelivery: sd as never, account: account as never, extraPanel: createElement('div', null, 'EXTRA-PANEL') }))
    expect(html.match(/EXTRA-PANEL/g)).toHaveLength(1)
  })
})
