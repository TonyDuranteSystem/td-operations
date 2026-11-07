import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The client has signed a form that belongs to a service delivery → the delivery moves on by itself
 * (lib/esign/delivery-advance.ts). Company Change Name: signing → filing. Idempotent, best-effort,
 * a refusal is reported (the client signed; staff must see the job did not move).
 */

let envelope: Record<string, unknown> | null = null
let sd: Record<string, unknown> | null = null
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.maybeSingle = () => Promise.resolve({ data: table === 'esign_envelopes' ? envelope : table === 'service_deliveries' ? sd : null, error: null })
      return c
    },
  },
}))
const advanceMock = vi.fn()
vi.mock('@/lib/service-delivery', () => ({ advanceServiceDelivery: (...a: unknown[]) => advanceMock(...a) }))
const reportMock = vi.fn().mockResolvedValue(null)
vi.mock('@/lib/system-errors', () => ({ reportSystemError: (...a: unknown[]) => reportMock(...a) }))

import { advanceDeliveryAfterEsign, advanceDeliveryAfterEsignSent, esignAdvanceTarget, esignSendTarget, ESIGN_COMPLETION_ADVANCE, ESIGN_SEND_ADVANCE } from '@/lib/esign/delivery-advance'
import { CHANGE_NAME_STAGES } from '@/lib/flows/change-name-stages'
import { TAX_RETURN_SIGN_STAGES } from '@/lib/flows/tax-return-sign-stages'
import { esignStatusLabel } from '@/lib/esign/delivery-envelopes'
import { parseStageLayout, STAGE_COMPONENT_TYPES } from '@/lib/flows/stage-layout'

beforeEach(() => {
  envelope = { id: 'env-1', status: 'completed', service_delivery_id: 'sd-1', document_name: 'Name change form' }
  sd = { id: 'sd-1', service_type: 'Company Change Name', stage: CHANGE_NAME_STAGES.sign, status: 'active' }
  advanceMock.mockReset()
  advanceMock.mockResolvedValue({ success: true })
  reportMock.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('esignAdvanceTarget (pure)', () => {
  it('a name change waiting on the signing step goes to filing', () => {
    expect(esignAdvanceTarget('Company Change Name', CHANGE_NAME_STAGES.sign)).toBe(CHANGE_NAME_STAGES.file)
  })
  it('a signature that arrives while the job is still on the check step also carries it to filing (never stranded)', () => {
    expect(esignAdvanceTarget('Company Change Name', CHANGE_NAME_STAGES.check)).toBe(CHANGE_NAME_STAGES.file)
  })
  it('a delivery at any other step, another service, or nothing is left alone', () => {
    expect(esignAdvanceTarget('Company Change Name', CHANGE_NAME_STAGES.collect)).toBeNull()
    expect(esignAdvanceTarget('Company Change Name', CHANGE_NAME_STAGES.file)).toBeNull()
    expect(esignAdvanceTarget('Tax Return', CHANGE_NAME_STAGES.sign)).toBeNull()
    expect(esignAdvanceTarget(null, CHANGE_NAME_STAGES.sign)).toBeNull()
    expect(esignAdvanceTarget('Company Change Name', null)).toBeNull()
  })
  it('the services with a signing rule: the name change and (since 2026-11-06) the Tax Return', () => {
    expect(Object.keys(ESIGN_COMPLETION_ADVANCE).sort()).toEqual(['Company Change Name', 'Tax Return'])
  })
  it('a Tax Return waiting on the client\'s signature goes to Signed', () => {
    expect(esignAdvanceTarget('Tax Return', TAX_RETURN_SIGN_STAGES.sent)).toBe('Signed')
  })
  it('a signature that arrives while the return is still on Preparation (the send did not move it) or on the older TR Completed also carries it to Signed — never stranded', () => {
    expect(esignAdvanceTarget('Tax Return', 'Preparation')).toBe('Signed')
    expect(esignAdvanceTarget('Tax Return', 'TR Completed')).toBe('Signed')
  })
  it('a Tax Return anywhere else is left alone — signing never moves a filed, already-signed or early return', () => {
    for (const s of ['Wizard Available', 'Data Submitted', 'Under Review', 'Data Received', 'Signed', 'TR Filed', 'Extension Filed']) {
      expect(esignAdvanceTarget('Tax Return', s), s).toBeNull()
    }
  })
})

describe('esignSendTarget (pure)', () => {
  it('a Tax Return on Preparation (or the older TR Completed) whose document is SENT goes to Sent for Signature', () => {
    expect(esignSendTarget('Tax Return', 'Preparation')).toBe('Sent for Signature')
    expect(esignSendTarget('Tax Return', 'TR Completed')).toBe('Sent for Signature')
  })
  it('sending moves nothing anywhere else: a return already out or signed, another step, another service (the name change moves on SIGNING only)', () => {
    for (const s of ['Sent for Signature', 'Signed', 'TR Filed', 'Data Received', 'Under Review']) expect(esignSendTarget('Tax Return', s), s).toBeNull()
    expect(esignSendTarget('Company Change Name', CHANGE_NAME_STAGES.sign)).toBeNull()
    expect(esignSendTarget(null, 'Preparation')).toBeNull()
    expect(esignSendTarget('Tax Return', null)).toBeNull()
    expect(Object.keys(ESIGN_SEND_ADVANCE)).toEqual(['Tax Return'])
  })
})

describe('advanceDeliveryAfterEsign', () => {
  it('moves the delivery from signing to filing and keeps the client notice on', async () => {
    const r = await advanceDeliveryAfterEsign('env-1')
    expect(r).toEqual({ advanced: true })
    expect(advanceMock).toHaveBeenCalledTimes(1)
    const call = advanceMock.mock.calls[0][0]
    expect(call).toMatchObject({ delivery_id: 'sd-1', target_stage: CHANGE_NAME_STAGES.file, actor: 'esign-completed', skip_tasks: true })
    expect(call.skip_notify).toBeUndefined()
  })

  it('is idempotent: a delivery already past the signing step is not moved again', async () => {
    sd = { id: 'sd-1', service_type: 'Company Change Name', stage: CHANGE_NAME_STAGES.file, status: 'active' }
    const r = await advanceDeliveryAfterEsign('env-1')
    expect(r.advanced).toBe(false)
    expect(advanceMock).not.toHaveBeenCalled()
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('does nothing for an envelope with no delivery, or one that is not fully signed', async () => {
    envelope = { id: 'env-1', status: 'completed', service_delivery_id: null }
    expect((await advanceDeliveryAfterEsign('env-1')).advanced).toBe(false)
    envelope = { id: 'env-1', status: 'in_progress', service_delivery_id: 'sd-1' }
    expect((await advanceDeliveryAfterEsign('env-1')).advanced).toBe(false)
    envelope = null
    expect((await advanceDeliveryAfterEsign('env-1')).advanced).toBe(false)
    expect(advanceMock).not.toHaveBeenCalled()
  })

  it('a REFUSED move (e.g. no confirmed name) is reported to the error dashboard — the client signed but the job did not move', async () => {
    advanceMock.mockResolvedValue({ success: false, error: 'The client has not confirmed a name yet.' })
    const r = await advanceDeliveryAfterEsign('env-1')
    expect(r).toEqual({ advanced: false, reason: 'The client has not confirmed a name yet.' })
    expect(reportMock).toHaveBeenCalledTimes(1)
    expect(reportMock.mock.calls[0][0].message).toContain('Move it by hand')
  })

  it('never throws, even when the move blows up', async () => {
    advanceMock.mockRejectedValue(new Error('db down'))
    const r = await advanceDeliveryAfterEsign('env-1')
    expect(r.advanced).toBe(false)
    expect(reportMock).toHaveBeenCalledTimes(1)
  })
})

describe('advanceDeliveryAfterEsignSent (a Tax Return document is sent from the workspace)', () => {
  beforeEach(() => {
    envelope = { id: 'env-1', status: 'sent', service_delivery_id: 'sd-1', document_name: 'Tax Return 2025 - Beta LLC' }
    sd = { id: 'sd-1', service_type: 'Tax Return', stage: 'Preparation', status: 'active' }
  })

  it('moves the job to Sent for Signature WITHOUT telling the client (the e-sign invite is the one message)', async () => {
    const r = await advanceDeliveryAfterEsignSent('env-1')
    expect(r).toEqual({ advanced: true })
    expect(advanceMock).toHaveBeenCalledTimes(1)
    expect(advanceMock.mock.calls[0][0]).toMatchObject({ delivery_id: 'sd-1', target_stage: 'Sent for Signature', actor: 'esign-sent', skip_tasks: true, skip_notify: true })
  })

  it('is idempotent: pressing Send again on a job already out with the client moves nothing', async () => {
    sd = { id: 'sd-1', service_type: 'Tax Return', stage: 'Sent for Signature', status: 'active' }
    expect((await advanceDeliveryAfterEsignSent('env-1')).advanced).toBe(false)
    expect(advanceMock).not.toHaveBeenCalled()
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('does nothing for an envelope with no job (sent from Tools > E-Sign on its own), an unsent one, or a service with no "sent" step', async () => {
    envelope = { id: 'env-1', status: 'sent', service_delivery_id: null }
    expect((await advanceDeliveryAfterEsignSent('env-1')).advanced).toBe(false)
    envelope = { id: 'env-1', status: 'draft', service_delivery_id: 'sd-1' }
    expect((await advanceDeliveryAfterEsignSent('env-1')).advanced).toBe(false)
    envelope = { id: 'env-1', status: 'sent', service_delivery_id: 'sd-1' }
    sd = { id: 'sd-1', service_type: 'Company Change Name', stage: CHANGE_NAME_STAGES.sign, status: 'active' }
    expect((await advanceDeliveryAfterEsignSent('env-1')).advanced).toBe(false)
    expect(advanceMock).not.toHaveBeenCalled()
  })

  it('a REFUSED move is reported to the error dashboard (the document is out but the job did not move) and never throws', async () => {
    advanceMock.mockResolvedValue({ success: false, error: 'Stage "Sent for Signature" not found.' })
    expect((await advanceDeliveryAfterEsignSent('env-1')).advanced).toBe(false)
    expect(reportMock).toHaveBeenCalledTimes(1)
    expect(reportMock.mock.calls[0][0].message).toContain('Sent for Signature')
    expect(reportMock.mock.calls[0][0].message).toContain('Move it by hand')
    advanceMock.mockRejectedValue(new Error('db down'))
    expect((await advanceDeliveryAfterEsignSent('env-1')).advanced).toBe(false)
  })

  it('after the client signs, the Tax Return goes on to Signed and the client notice stays on', async () => {
    envelope = { id: 'env-1', status: 'completed', service_delivery_id: 'sd-1', document_name: 'Tax Return 2025 - Beta LLC' }
    sd = { id: 'sd-1', service_type: 'Tax Return', stage: 'Sent for Signature', status: 'active' }
    expect(await advanceDeliveryAfterEsign('env-1')).toEqual({ advanced: true })
    const call = advanceMock.mock.calls[0][0]
    expect(call).toMatchObject({ delivery_id: 'sd-1', target_stage: 'Signed', actor: 'esign-completed', skip_tasks: true })
    expect(call.skip_notify).toBeUndefined()
  })
})

describe('wiring', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('finalizeEsignCompletion calls the hook inside its own try/catch, after filing', () => {
    const src = read('lib/operations/esign.ts')
    const filing = src.indexOf('fileEsignSignedPdf(envelopeId)')
    const hook = src.indexOf('advanceDeliveryAfterEsign(envelopeId)')
    expect(filing).toBeGreaterThan(0)
    expect(hook).toBeGreaterThan(filing)
    expect(src.slice(hook - 200, hook)).toContain('try {')
  })

  it('the send route moves the job AFTER the envelope is marked sent, in its own try/catch (it never fails the send)', () => {
    const src = read('app/api/esign/envelopes/[id]/send/route.ts')
    const marked = src.indexOf('status: "sent"')
    const hook = src.indexOf('advanceDeliveryAfterEsignSent(id)')
    expect(marked).toBeGreaterThan(0)
    expect(hook).toBeGreaterThan(marked)
    expect(src.slice(hook - 250, hook)).toContain('try {')
  })

  it('the staff editor links the envelope to the delivery (page param → editor prop → payload)', () => {
    expect(read('app/(dashboard)/tools/esign/new/page.tsx')).toContain('serviceDeliveryId={serviceDeliveryId}')
    const editor = read('app/(dashboard)/tools/esign/new/esign-editor.tsx')
    expect(editor).toContain('service_delivery_id: serviceDeliveryId')
  })

  it('the layout engine knows the esign_panel component', () => {
    expect(STAGE_COMPONENT_TYPES).toContain('esign_panel')
    const parsed = parseStageLayout({ components: [{ type: 'esign_panel', label: 'Prepare it' }, { type: 'bogus' }] })
    expect(parsed?.components.map((c) => c.type)).toEqual(['esign_panel'])
  })
})

describe('esignStatusLabel', () => {
  it('speaks plain English for the real statuses', () => {
    expect(esignStatusLabel('draft')).toBe('Not sent yet')
    expect(esignStatusLabel('sent')).toMatch(/waiting for the client/)
    expect(esignStatusLabel('completed')).toBe('Signed')
    expect(esignStatusLabel('voided')).toBe('Cancelled')
    expect(esignStatusLabel('something_new')).toBe('something_new')
    expect(esignStatusLabel(null)).toBe('Unknown')
  })
})
