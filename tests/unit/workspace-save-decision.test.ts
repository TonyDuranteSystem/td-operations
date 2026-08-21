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

  // 2026-08-20 hard-stop plan: an unreadable statement or an unresolved
  // missing-months question means the workspace's numbers could be badly
  // wrong, not just provisional — refuse outright, checked BEFORE mode/
  // existingCount, no override for either audience.
  it('refuses a structural data problem before anything else, even an empty target with no mode needed', () => {
    const d = decideSaveToClient({ existingCount: 0, inFlightJobs: 0, hasStructuralProblem: true })
    expect(d.action).toBe('refuse')
    expect(d.reason).toMatch(/unresolved data problem/i)
  })

  it('refuses a structural problem even with an explicit Merge/Replace mode already chosen', () => {
    expect(decideSaveToClient({ existingCount: 120, inFlightJobs: 0, mode: 'merge', hasStructuralProblem: true }).action).toBe('refuse')
    expect(decideSaveToClient({ existingCount: 120, inFlightJobs: 0, mode: 'replace', hasStructuralProblem: true }).action).toBe('refuse')
  })

  it('hasStructuralProblem: false (or omitted) does not change any existing outcome', () => {
    expect(decideSaveToClient({ existingCount: 0, inFlightJobs: 0, hasStructuralProblem: false }).action).toBe('insert')
    expect(decideSaveToClient({ existingCount: 120, inFlightJobs: 0, mode: 'merge', hasStructuralProblem: false }).action).toBe('merge')
  })
})
