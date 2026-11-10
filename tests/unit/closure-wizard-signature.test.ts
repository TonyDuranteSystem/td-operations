import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  applyClosureSignatureConsent,
  clientIpFromForwardedFor,
  looksLikePng,
  signaturePathsOf,
  CLOSURE_SIGNATURE_CONSENT_EN,
  CLOSURE_SIGNATURE_CONSENT_IT,
  CLOSURE_SIGNATURE_FIELD,
} from '@/lib/closure/signature-consent'
import { CLOSURE_FIELDS } from '@/components/portal/wizard/wizard-configs'
import { einClosureLetterLines } from '@/lib/closure/ein-closure-letter'
import { EIN_LETTER_BODY_CLOSE, EIN_LETTER_REQUEST, EIN_LETTER_TO } from '@/lib/closure/ein-letter-wording'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const GOOD = 'closure/6a2f0c1e-1111-4222-8333-444455556666/signature_image_ab12cd34_signature.png'
const ctx = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone)', now: new Date('2026-11-10T18:30:00Z') }

describe('applyClosureSignatureConsent — the server owns the consent record', () => {
  it('records the consent text, time, address and browser for a client who drew a signature', () => {
    const data: Record<string, unknown> = { llc_name: 'X LLC', [CLOSURE_SIGNATURE_FIELD]: [GOOD] }
    expect(applyClosureSignatureConsent(data, ctx)).toEqual({ signed: true })
    expect(data[CLOSURE_SIGNATURE_FIELD]).toEqual([GOOD])
    expect(data.signature_consent).toBe(CLOSURE_SIGNATURE_CONSENT_EN)
    expect(data.signature_consent_locale).toBe('en')
    expect(data.signature_signed_at).toBe('2026-11-10T18:30:00.000Z')
    expect(data.signature_ip).toBe('203.0.113.7')
    expect(data.signature_user_agent).toBe('Mozilla/5.0 (iPhone)')
    expect(data.llc_name).toBe('X LLC') // the other answers are untouched
  })

  it('records the Italian text when the client saw the Italian wizard, and removes the language hint', () => {
    const data: Record<string, unknown> = { [CLOSURE_SIGNATURE_FIELD]: [GOOD], signature_locale: 'it' }
    applyClosureSignatureConsent(data, ctx)
    expect(data.signature_consent).toBe(CLOSURE_SIGNATURE_CONSENT_IT)
    expect(data.signature_consent_locale).toBe('it')
    expect('signature_locale' in data).toBe(false)
  })

  it('throws away a consent record the client sent for themselves, and records nothing without a signature', () => {
    const forged: Record<string, unknown> = { signature_consent: 'anything', signature_signed_at: '2020-01-01', signature_ip: '1.1.1.1', signature_user_agent: 'x', signature_consent_locale: 'it' }
    expect(applyClosureSignatureConsent(forged, ctx)).toEqual({ signed: false })
    expect(Object.keys(forged)).toEqual([])
  })

  it('only accepts a path the wizard minted for this field (no other file, no path tricks)', () => {
    for (const bad of ['closure/x/ein_letter_ab12cd34_signature.png', '../signature_image_x', 'signature_image_ab12cd34_x.png', 'closure/a/b/signature_image_x.png', 'formation/x/signature_image_ab12cd34_s.png', 42, null, {}]) {
      const data: Record<string, unknown> = { [CLOSURE_SIGNATURE_FIELD]: [bad] }
      expect(applyClosureSignatureConsent(data, ctx).signed).toBe(false)
      expect(CLOSURE_SIGNATURE_FIELD in data).toBe(false)
    }
    expect(signaturePathsOf(GOOD)).toEqual([GOOD]) // a single string value counts too
  })

  it('keeps only the LAST drawing when there are several', () => {
    const second = GOOD.replace('ab12cd34', 'ee99ff00')
    const data: Record<string, unknown> = { [CLOSURE_SIGNATURE_FIELD]: [GOOD, second] }
    applyClosureSignatureConsent(data, ctx)
    expect(data[CLOSURE_SIGNATURE_FIELD]).toEqual([second])
  })

  it('cuts a very long browser string', () => {
    const data: Record<string, unknown> = { [CLOSURE_SIGNATURE_FIELD]: [GOOD] }
    applyClosureSignatureConsent(data, { ...ctx, userAgent: 'x'.repeat(1000) })
    expect(String(data.signature_user_agent)).toHaveLength(300)
  })
})

describe('small helpers', () => {
  it('takes the first address of the forwarded-for header', () => {
    expect(clientIpFromForwardedFor('203.0.113.7, 10.0.0.1')).toBe('203.0.113.7')
    expect(clientIpFromForwardedFor('')).toBeNull()
    expect(clientIpFromForwardedFor(null)).toBeNull()
  })
  it('knows a PNG when it sees one', () => {
    expect(looksLikePng(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe(true)
    expect(looksLikePng(Uint8Array.from(Buffer.from('%PDF-1.7 not a picture')))).toBe(false)
    expect(looksLikePng(new Uint8Array())).toBe(false)
  })
})

describe('the wizard shows the same words the letter prints', () => {
  it('the letter and the wizard preview share one wording file', () => {
    const l = einClosureLetterLines({ companyName: 'X LLC', ein: '12-3456789', companyAddressLines: ['1 Main St'], signerName: 'A B', date: new Date(), includesEinNotice: false })
    expect(l.fields[0].lines).toEqual([EIN_LETTER_TO])
    expect(l.fields[1].lines).toEqual([EIN_LETTER_REQUEST])
    expect(l.body[0]).toBe(EIN_LETTER_BODY_CLOSE)
    const preview = read('components/portal/wizard/wizard-signature-field.tsx')
    expect(preview).toContain('EIN_LETTER_BODY_CLOSE')
    expect(preview).toContain('EIN_LETTER_REQUEST')
    expect(preview).toContain('CLOSURE_SIGNATURE_CONSENT_EN')
    expect(preview).toContain('CLOSURE_SIGNATURE_CONSENT_IT')
  })
})

describe('the signature box is wired into the closure wizard', () => {
  it('is a REQUIRED field of the documents step with the words Antonio chose, in English and Italian', () => {
    const f = CLOSURE_FIELDS.documents.find((x) => x.name === 'signature_image')
    expect(f).toBeDefined()
    expect(f?.type).toBe('signature')
    expect(f?.required).toBe(true) // Antonio 2026-11-10: "it's required"
    expect(f?.label).toBe('Draw your signature here for the EIN letter to send to the IRS for its closure')
    expect(f?.labelIt).toMatch(/firma/)
  })

  it('the wizard field draws it, and the form page hands it the answers so far', () => {
    const field = read('components/portal/wizard/wizard-field.tsx')
    expect(field).toContain("field.type === 'signature'")
    expect(field).toContain('<WizardSignatureField')
    expect(read('app/portal/wizard/wizard-client.tsx')).toContain('context={formData}')
  })

  it('the picture goes through the normal wizard upload under the field name, and the language hint is sent with it', () => {
    const c = read('components/portal/wizard/wizard-signature-field.tsx')
    expect(c).toContain('onFileUpload(name, file)')
    expect(c).toContain('CLOSURE_SIGNATURE_LOCALE_HINT')
    expect(c).toContain("new File([blob], 'signature.png'")
  })

  it('the submit route writes the consent record for a closure, before the answers are stored', () => {
    const route = read('app/api/portal/wizard-submit/route.ts')
    const at = route.indexOf('applyClosureSignatureConsent(')
    expect(at).toBeGreaterThan(0)
    expect(route).toContain("wizard_type === 'closure' && typeof data === 'object'")
    expect(at).toBeLessThan(route.indexOf('buildSubmissionRecord(submissionTable'))
  })

  it('the server refuses a closure sent without a valid signature, with a plain sentence (the wizard gate stops it first)', () => {
    const route = read('app/api/portal/wizard-submit/route.ts')
    expect(route).toContain('if (!sig.signed)')
    expect(route).toContain('Please draw your signature for the EIN letter before sending the closure form.')
    expect(route).toMatch(/!sig\.signed\)[\s\S]{0,260}status: 400/)
  })
})
