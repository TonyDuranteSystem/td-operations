/**
 * A stage-layout note stored in the database must not carry its own copy of the
 * office address.
 *
 * THE DRIFT THIS PINS (production, found 2026-07-22): the ITIN "Client Signing"
 * staff note read "11125 Park Blvd Suite 104-153, Seminole, Florida 33772" —
 * no comma before Suite, "Florida" spelled out — while the code said
 * "11125 Park Blvd, Suite 104-153, Seminole, FL 33772". Two copies, already
 * disagreeing. The row now stores `{td_mailing_address}` and the parser fills
 * it from the single source, so it cannot drift again.
 */

import { describe, it, expect } from 'vitest'
import { parseStageLayout } from '@/lib/flows/stage-layout'
import { MAILING_DESTINATION_ONE_LINE, TD_OFFICE } from '@/lib/td-address'

/** The exact shape of the production row, post-fix. */
const ITIN_CLIENT_SIGNING = {
  components: [
    { type: 'waiting_notice', label: 'Mail to: {td_mailing_address}' },
  ],
}

describe('stage_layout address token', () => {
  it('renders the address from the single source', () => {
    const layout = parseStageLayout(ITIN_CLIENT_SIGNING)

    expect(layout?.components[0].label).toBe(`Mail to: ${MAILING_DESTINATION_ONE_LINE}`)
    expect(layout?.components[0].label).not.toContain('{')
  })

  it('carries the code spelling, not the drifted one', () => {
    const label = parseStageLayout(ITIN_CLIENT_SIGNING)?.components[0].label ?? ''

    expect(label).toContain(TD_OFFICE.street) // "Park Blvd, Suite 104-153"
    expect(label).toContain('Seminole, FL 33772')
    expect(label).not.toContain('Florida') // the drifted spelling
  })

  it('resolves tokens in the stage description too', () => {
    const layout = parseStageLayout({
      components: [],
      description: 'Send it to {td_mailing_address}.',
    })

    expect(layout?.description).toBe(`Send it to ${MAILING_DESTINATION_ONE_LINE}.`)
  })

  it('leaves an unknown token literal — a visible gap beats a silent blank', () => {
    const layout = parseStageLayout({
      components: [{ type: 'waiting_notice', label: 'Hi {not_a_token}' }],
    })

    expect(layout?.components[0].label).toBe('Hi {not_a_token}')
  })

  it('leaves plain text untouched', () => {
    const layout = parseStageLayout({
      components: [{ type: 'waiting_notice', label: 'Waiting for the client.' }],
    })

    expect(layout?.components[0].label).toBe('Waiting for the client.')
  })
})
