/**
 * createSD (lib/operations/service-delivery.ts) asks the client for the new company names the moment a
 * Company Change Name starts. Source-level wiring check (the same style as the other wiring tests):
 * createSD is the ONE place every creation path goes through (standalone contract, bundled contract),
 * so the first ask lives there, guarded by its own try/catch so it can never roll back the delivery.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), 'lib/operations/service-delivery.ts'), 'utf8')

describe('createSD first ask for a name change', () => {
  it('calls askFirstNamesAtCreation for a Company Change Name only, inside its own try/catch', () => {
    const at = src.indexOf('askFirstNamesAtCreation(row.id)')
    expect(at).toBeGreaterThan(0)
    const before = src.slice(Math.max(0, at - 400), at)
    expect(before).toContain('row.service_type === "Company Change Name"')
    expect(before).toContain('try {')
    const after = src.slice(at, at + 400)
    expect(after).toContain('} catch')
  })

  it('runs after the workflow dispatch and before the universal fallback task', () => {
    const dispatch = src.indexOf('dispatchWorkflowForSdCreated({')
    const ask = src.indexOf('askFirstNamesAtCreation(row.id)')
    const fallback = src.indexOf('if (!workflowSpawned && row.service_type !== "Company Change Name") {')
    expect(dispatch).toBeGreaterThan(0)
    expect(ask).toBeGreaterThan(dispatch)
    expect(fallback).toBeGreaterThan(ask)
  })

  it('a name change never gets the plain fallback card (its workflow is retired; the Calendar is the to-do)', () => {
    expect(src).toContain('if (!workflowSpawned && row.service_type !== "Company Change Name") {')
    // every OTHER service keeps the fallback
    expect(src).not.toContain('if (!workflowSpawned) {')
  })

  it('the helper it calls is idempotent per delivery and never throws (documented + exported)', () => {
    const ops = readFileSync(join(process.cwd(), 'lib/operations/formation-name-checks.ts'), 'utf8')
    expect(ops).toContain('export async function askFirstNamesAtCreation')
    expect(ops).toContain('hasAnyNewNamesRequest')
    expect(ops).toContain('Never throws')
  })
})
