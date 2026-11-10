import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { STAGE_COMPONENT_TYPES } from '@/lib/flows/stage-layout'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('EIN closure letter — the pieces are wired together', () => {
  it('the box is a known layout component and the renderer draws it', () => {
    expect(STAGE_COMPONENT_TYPES as readonly string[]).toContain('ein_closure_letter_panel')
    const r = read('components/flows/stage-renderer.tsx')
    expect(r).toContain("case 'ein_closure_letter_panel':")
    expect(r).toContain('<EinClosureLetterPanel')
  })

  it('the route is staff only on both verbs and never returns the PDF itself', () => {
    const route = read('app/api/flows/[id]/ein-closure-letter/route.ts')
    expect((route.match(/requireStaffRoute\(\)/g) ?? []).length).toBe(2)
    expect(route).not.toMatch(/application\/pdf/) // saved on the job, opened from the documents list (the host cuts responses over 4.5 MB)
    expect(route).toContain('splitAddress(body.address)')
  })

  it('the migration adds the box under the waiting notice, is guarded and can be undone', () => {
    const up = read('scripts/migrations/20261110-1300-closure-ein-letter-panel.sql')
    expect(up).toContain("'ein_closure_letter_panel'")
    expect(up).toContain("v_comps->0->>'type' IS DISTINCT FROM 'waiting_notice'") // refuses an unexpected shape
    expect(up).toContain('already there')                                         // re-runnable
    const down = read('scripts/migrations/20261110-1300-closure-ein-letter-panel.UNDO.sql')
    expect(down).toContain("IS DISTINCT FROM 'ein_closure_letter_panel'")
    expect(down).toContain('Fill out the EIN closure letter, print it and mail it to the IRS')
  })

  it('the letter never takes a signature from anywhere but the client’s own drawing (no passport, no ID)', () => {
    const pkg = read('lib/closure/ein-closure-package.ts')
    expect(pkg).toContain('signaturePng: null') // until the wizard box exists nothing is embedded
    expect(pkg).not.toMatch(/passport/i)
  })
})
