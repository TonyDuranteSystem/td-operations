/**
 * buildRefineUserPrompt's optional emailContext block (dev job 3c1bb5fa,
 * 2026-08-28) — added so the "Discuss with AI" box can ground an answer in
 * a real email when one was found. Pins that the block only appears when
 * context was actually found, never implied otherwise.
 */

import { describe, it, expect } from 'vitest'
import { buildRefineUserPrompt } from '@/lib/offers/narrative-business-rules'

const baseOpts = {
  clientName: 'Francesco Rossi',
  contractType: 'formation',
  entityType: 'Multi-Member LLC',
  serviceLines: ['Company Formation — LLC setup'],
  current: { intro_en: 'Hello.' },
  instruction: 'read the email from francesco and update the intro',
}

describe('buildRefineUserPrompt — emailContext', () => {
  it('includes a RELEVANT EMAIL block when emailContext is given', () => {
    const prompt = buildRefineUserPrompt({ ...baseOpts, emailContext: 'From: francesco@example.com\nI want a Wyoming LLC.' })
    expect(prompt).toContain('RELEVANT EMAIL')
    expect(prompt).toContain('I want a Wyoming LLC.')
  })

  it('omits the block entirely when emailContext is absent', () => {
    const prompt = buildRefineUserPrompt(baseOpts)
    expect(prompt).not.toContain('RELEVANT EMAIL')
  })

  it('omits the block when emailContext is an empty string, not just undefined', () => {
    const prompt = buildRefineUserPrompt({ ...baseOpts, emailContext: '' })
    expect(prompt).not.toContain('RELEVANT EMAIL')
  })
})
