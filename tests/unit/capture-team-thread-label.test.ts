import { describe, it, expect } from 'vitest'
import { teamThreadDisplayLabel } from '@/lib/captures/team-thread-label'

describe('team thread display label', () => {
  it('a discussion thread with a title shows the title, not the bare label', () => {
    expect(
      teamThreadDisplayLabel({ id: 't1', label: 'QA Alpha LLC', title: 'QA Alpha LLC — tax', thread_type: 'discussion' }),
    ).toBe('QA Alpha LLC — tax')
  })

  it('three discussion threads for the same client are no longer indistinguishable', () => {
    const threads = [
      { id: 't1', label: 'QA Alpha LLC', title: 'QA Alpha LLC — closure', thread_type: 'discussion' },
      { id: 't2', label: 'QA Alpha LLC', title: 'QA Alpha LLC — tax', thread_type: 'discussion' },
      { id: 't3', label: 'QA Alpha LLC', title: 'QA Alpha LLC — banking', thread_type: 'discussion' },
    ]
    const labels = threads.map(teamThreadDisplayLabel)
    expect(new Set(labels).size).toBe(3)
  })

  it('a discussion thread with no title falls back to the bare label', () => {
    expect(teamThreadDisplayLabel({ id: 't1', label: 'Acme LLC', title: null, thread_type: 'discussion' })).toBe('Acme LLC')
  })

  it('the general thread never shows its internal sentinel title', () => {
    expect(teamThreadDisplayLabel({ id: 'g1', label: 'general', title: '__team_general__', thread_type: 'general' })).toBe('general')
  })

  it('a channel thread uses its label, ignoring a differently-worded title', () => {
    expect(
      teamThreadDisplayLabel({ id: 'c1', label: 'QA Attachments', title: 'QA — attachment card', thread_type: 'channel' }),
    ).toBe('QA Attachments')
  })

  it('falls back to the id when both label and title are empty', () => {
    expect(teamThreadDisplayLabel({ id: 'x1', label: '', title: null, thread_type: 'dm' })).toBe('x1')
  })
})
