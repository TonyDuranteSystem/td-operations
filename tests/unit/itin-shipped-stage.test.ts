import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { protectedStageReason } from '@/lib/services/protected-stage-names'

const read = (p: string) => readFileSync(p, 'utf8')

describe('ITIN "Shipped" stage (Antonio 2026-10-21)', () => {
  it('the client mailing path (legacy fallback) moves the case to Shipped, never to Documents Received', () => {
    const src = read('lib/portal/itin-mailing.ts')
    expect(src).toMatch(/target_stage:\s*'Shipped'/)
    expect(src).not.toMatch(/target_stage:\s*'Documents Received'/)
  })
  it('the name is protected (code moves a case onto it by name)', () => {
    expect(protectedStageReason('Shipped')).toMatch(/tracking/)
  })
  it('the migration puts Shipped between Client Signing and Documents Received and points the catalog chain at it', () => {
    const sql = read('scripts/migrations/20261021-1800-itin-shipped-stage.sql')
    expect(sql).toMatch(/Client Signing > Shipped > Documents Received/)
    expect(sql).toContain('"Shipped"')
    expect(sql).toMatch(/waiting_on|'outside'/)
    expect(read('scripts/migrations/20261021-1800-itin-shipped-stage.UNDO.sql')).toMatch(/Documents Received/)
  })
})
