/**
 * The extension at the steps AFTER the tax form opens, and "no extension needed" (Antonio, 22 Nov 2026, dev job 6f555c9f) — the pure rules in
 * lib/fax/extension-fax.ts, plus what the two migrations promise.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXTENSION_BOX_WHERE_TEXT,
  EXTENSION_LATER_STAGES,
  EXTENSION_STAGES,
  decideExtensionSkip,
  extensionMovesJob,
  isExtensionBoxStage,
} from '@/lib/fax/extension-fax'

describe('which steps the extension box works at', () => {
  it('works at the first step and at every step from Wizard Available to Preparation', () => {
    expect(isExtensionBoxStage('1st Installment Paid')).toBe(true)
    for (const s of ['Wizard Available', 'Data Submitted', 'Under Review', 'Revision Requested', 'Approved', 'Confirmed', 'Data Received', 'Preparation']) {
      expect(isExtensionBoxStage(s)).toBe(true)
    }
    expect(EXTENSION_LATER_STAGES).toHaveLength(8)
  })
  it('does not work anywhere else (before the form, after the return is prepared, once filed)', () => {
    for (const s of ['Company Data Pending', 'Paid - Awaiting Data', 'Extension Filed', 'Awaiting 2nd Payment', '2nd Installment Paid', 'Sent for Signature', 'Signed', 'TR Completed', 'TR Filed', 'Terminated - Non Payment']) {
      expect(isExtensionBoxStage(s)).toBe(false)
    }
    expect(isExtensionBoxStage(null)).toBe(false)
    expect(isExtensionBoxStage(undefined)).toBe(false)
    expect(isExtensionBoxStage('')).toBe(false)
  })
  it('only the first step moves the job to Extension Filed', () => {
    expect(extensionMovesJob(EXTENSION_STAGES.waiting)).toBe(true)
    for (const s of EXTENSION_LATER_STAGES) expect(extensionMovesJob(s)).toBe(false)
    expect(extensionMovesJob(null)).toBe(false)
  })
  it('the words used in refusals name both places', () => {
    expect(EXTENSION_BOX_WHERE_TEXT).toContain('1st Installment Paid')
    expect(EXTENSION_BOX_WHERE_TEXT).toContain('Wizard Available')
    expect(EXTENSION_BOX_WHERE_TEXT).toContain('Preparation')
  })
})

describe('decideExtensionSkip', () => {
  const base = { stage: 'Wizard Available', status: 'active', hasRecord: true, extensionFiled: false, alreadySkipped: false, faxInProgress: false, skip: true }

  it('allows "no extension needed" at a later step with nothing filed and no fax on its way', () => {
    expect(decideExtensionSkip(base)).toEqual({ ok: true })
    for (const stage of EXTENSION_LATER_STAGES) expect(decideExtensionSkip({ ...base, stage })).toEqual({ ok: true })
  })
  it('refuses at the first step: every annual client\'s extension is filed there', () => {
    const r = decideExtensionSkip({ ...base, stage: '1st Installment Paid' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('every annual client')
  })
  it('refuses at steps outside the later range', () => {
    for (const stage of ['Company Data Pending', 'Paid - Awaiting Data', 'Extension Filed', 'TR Filed', null]) {
      expect(decideExtensionSkip({ ...base, stage }).ok).toBe(false)
    }
  })
  it('refuses when the extension is already filed, or a fax is on its way or unconfirmed', () => {
    expect(decideExtensionSkip({ ...base, extensionFiled: true }).ok).toBe(false)
    const fax = decideExtensionSkip({ ...base, faxInProgress: true })
    expect(fax.ok).toBe(false)
    if (!fax.ok) expect(fax.error).toContain('Fax History')
  })
  it('refuses for a cancelled job or when there is no tax record to write on', () => {
    expect(decideExtensionSkip({ ...base, status: 'cancelled' }).ok).toBe(false)
    const none = decideExtensionSkip({ ...base, hasRecord: false })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error).toContain('tax record')
  })
  it('choosing it twice is harmless (no change)', () => {
    expect(decideExtensionSkip({ ...base, alreadySkipped: true })).toEqual({ ok: true, noop: true })
  })
  it('undo works when it was skipped, and is harmless when it was not', () => {
    expect(decideExtensionSkip({ ...base, skip: false, alreadySkipped: true })).toEqual({ ok: true })
    expect(decideExtensionSkip({ ...base, skip: false, alreadySkipped: false })).toEqual({ ok: true, noop: true })
  })
  it('undo is allowed at any step that has the record (it only clears the choice)', () => {
    expect(decideExtensionSkip({ ...base, skip: false, alreadySkipped: true, stage: 'TR Filed' })).toEqual({ ok: true })
    expect(decideExtensionSkip({ ...base, skip: false, hasRecord: false }).ok).toBe(false)
  })
})

describe('the migrations', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), 'scripts/migrations', f), 'utf8')
  it('the skip columns are two additive nullable columns, added only when missing', () => {
    const sql = read('20261122-1900-tax-returns-extension-skipped.sql')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS extension_skipped_at timestamptz')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS extension_skipped_by text')
    expect(sql).not.toMatch(/DROP\s|NOT NULL|DELETE\s|UPDATE\s/i)
  })
  it('the layout migration adds the box to the 8 later steps once, never twice, and does not auto-advance', () => {
    const sql = read('20261122-1910-extension-box-later-steps.sql')
    for (const s of EXTENSION_LATER_STAGES) expect(sql).toContain(`'${s}'`)
    expect(sql).toContain('"autoAdvance": false')
    expect(sql).toContain("x->>'type' = 'extension_fax_panel'") // skip a step that already has the box
    expect(sql).toContain('jsonb_insert') // placed before the chat, nothing else reordered
  })
})
