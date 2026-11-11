import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('second production QA (2026-11-10) — the fixes are wired where the problems were', () => {
  it('every staff upload that builds a temporary storage path from the file name cleans the name', () => {
    for (const f of ['components/flows/document-upload.tsx', 'components/contacts/contact-detail.tsx', 'components/accounts/account-detail.tsx']) {
      const src = read(f)
      expect(src, f).toContain("from '@/lib/storage/staging-name'")
      expect(src, f).toMatch(/stagingFileName\((picked|file)\.name\)/)
      expect(src, f).not.toMatch(/Date\.now\(\)\}_\$\{(picked|file)\.name\}/)
    }
  })

  it('the flow upload refuses an empty or fake PDF before anything is saved, and the document lock ignores a 0-byte row', () => {
    const route = read('app/api/flows/[id]/upload-document/route.ts')
    expect(route).toContain('uploadContentProblem')
    expect(route.indexOf('uploadContentProblem')).toBeLessThan(route.indexOf('pilotSaveFormationUpload('))
    const gate = read('lib/service-delivery.ts')
    expect(gate).toMatch(/select\("flow_stage, file_size"\)/)
    expect(gate).toMatch(/d\.file_size > 0/)
  })

  it('the staff tracking route checks the number and saves it without spaces or dashes', () => {
    const route = read('app/api/flows/[id]/irs-tracking/route.ts')
    expect(route).toContain('trackingNumberProblem(courier, rawTracking)')
    expect(route).toMatch(/rawTracking\.replace\(\/\[\\s-\]\+\/g, ''\)/)
  })

  it('Go Back sends the step the page showed and the server refuses a stale or simultaneous second one', () => {
    expect(read('components/flows/go-back-button.tsx')).toContain('expected_from_stage')
    expect(read('app/(dashboard)/flows/[id]/page.tsx')).toMatch(/currentStage=\{sd\.stage\}/)
    expect(read('app/api/flows/[id]/revert/route.ts')).toContain('expected_from_stage')
    const op = read('lib/operations/service-delivery.ts')
    expect(op).toContain('REVERT_JOB_MOVED')
    expect(op).toMatch(/revertUpdate\.eq\("stage", sd\.stage\)/)
    expect(op).toMatch(/isClosureLetter/)
  })

  it('the wizard routes check the document boxes and the closure submit drops other people’s upload paths before the signature check', () => {
    expect(read('app/api/portal/wizard-upload-url/route.ts')).toContain('wizardFileTypeProblem(fieldName, fileName)')
    expect(read('app/api/portal/wizard-upload/route.ts')).toContain('wizardFileTypeProblem(fieldName, file.name)')
    const submit = read('app/api/portal/wizard-submit/route.ts')
    expect(submit).toContain('dropForeignUploadPaths(closureData, ownFolders)')
    expect(submit.indexOf('dropForeignUploadPaths(closureData')).toBeLessThan(submit.indexOf('verifyClosureSignatureFile('))
  })

  it('the intake route checks that the named job belongs to the submitter before reading its status', () => {
    const route = read('app/api/closure-form-completed/route.ts')
    expect(route).toContain('That closure does not belong to this submission.')
    expect(route.indexOf('That closure does not belong')).toBeLessThan(route.indexOf('This closure is no longer active'))
  })

  it('the letter box lets staff fix the name and EIN only when there is no company of ours, and forgets the EIN copy after a stale-box 409', () => {
    const panel = read('components/flows/ein-closure-letter-panel.tsx')
    expect(panel).toContain('!facts.hasCompany')
    expect(panel).toMatch(/company_name: edit\.name, ein: edit\.ein/)
    expect(panel).toMatch(/res\.status === 409\) \{\s*\/\/[^\n]*\n\s*setNoticeId\(null\)/)
  })

  it('the signature box fills its language hint only when the re-opened form has none (a hint from signing time is never rewritten)', () => {
    expect(read('components/portal/wizard/wizard-signature-field.tsx')).toMatch(/saved && !shownLocale\) onChange\(CLOSURE_SIGNATURE_LOCALE_HINT, locale\)/)
  })

  it('Go Back claims the step BEFORE it deletes or trashes anything (a lost race must leave the files alone)', () => {
    const op = read('lib/operations/service-delivery.ts')
    const fn = op.slice(op.indexOf('export async function revertServiceDelivery'))
    const claim = fn.indexOf('revertUpdate.eq("stage", sd.stage)')
    expect(claim).toBeGreaterThan(0)
    expect(claim).toBeLessThan(fn.indexOf('store_trash_file'))
    expect(claim).toBeLessThan(fn.indexOf('.delete()'))
  })

  it('the tracking route treats a number saved with spaces before this change as the same number', () => {
    const route = read('app/api/flows/[id]/irs-tracking/route.ts')
    expect(route).toMatch(/String\(existing\.tracking_number \?\? ''\)\.replace\(\/\[\\s-\]\+\/g, ''\) === trackingNumber/)
    expect(route).toContain('findDuplicate(trackingNumber, params.id, [rawTracking])')
  })
})

