/**
 * decideSaveToClient — the pure safety gate for writing a standalone P&L
 * workspace into a real client's books. Non-destructive by default; concurrency
 * always wins.
 */

import { describe, it, expect } from 'vitest'
import { decideSaveToClient } from '@/lib/tax/workspace-save'

describe('decideSaveToClient', () => {
  it('refuses while the client wizard is mid-ingest, regardless of everything else', () => {
    expect(decideSaveToClient({ existingCount: 0, inFlightJobs: 1 }).action).toBe('refuse')
    expect(decideSaveToClient({ existingCount: 500, inFlightJobs: 2, mode: 'replace' }).action).toBe('refuse')
  })

  it('inserts straight into an EMPTY target year (no mode needed)', () => {
    expect(decideSaveToClient({ existingCount: 0, inFlightJobs: 0 }).action).toBe('insert')
  })

  it('refuses a non-empty target when no mode is chosen (never silently mixes)', () => {
    const d = decideSaveToClient({ existingCount: 120, inFlightJobs: 0 })
    expect(d.action).toBe('refuse')
    expect(d.reason).toMatch(/Merge.*Replace/)
  })

  it('honors an explicit Merge on a non-empty target', () => {
    expect(decideSaveToClient({ existingCount: 120, inFlightJobs: 0, mode: 'merge' }).action).toBe('merge')
  })

  it('honors an explicit Replace on a non-empty target', () => {
    expect(decideSaveToClient({ existingCount: 120, inFlightJobs: 0, mode: 'replace' }).action).toBe('replace')
  })
})

describe('decideSaveToClient — client-answer protection (S2 slice 5)', () => {
  it('refuses Replace when the client has answered anything', () => {
    const d = decideSaveToClient({ existingCount: 120, inFlightJobs: 0, mode: 'replace', clientAnswerCount: 7 })
    expect(d.action).toBe('refuse')
    expect(d.reason).toMatch(/answered 7/)
  })

  it('Merge stays allowed with client answers present (add-only, never overwrites)', () => {
    expect(decideSaveToClient({ existingCount: 120, inFlightJobs: 0, mode: 'merge', clientAnswerCount: 7 }).action).toBe('merge')
  })

  it('Replace still works when the client has answered nothing', () => {
    expect(decideSaveToClient({ existingCount: 120, inFlightJobs: 0, mode: 'replace', clientAnswerCount: 0 }).action).toBe('replace')
  })

  it('fail-closed sentinel refuses Replace', () => {
    expect(decideSaveToClient({ existingCount: 120, inFlightJobs: 0, mode: 'replace', clientAnswerCount: Number.MAX_SAFE_INTEGER }).action).toBe('refuse')
  })
})
