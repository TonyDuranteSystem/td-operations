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
  signatureFingerprint,
  normalizeCompanyName,
  einDigits,
  sameSignedCompany,
  presentClosureAnswers,
  withoutSignatureRecord,
  readPngSize,
  MAX_SIGNATURE_PIXELS,
} from '@/lib/closure/signature-consent'
import { CLOSURE_FIELDS } from '@/components/portal/wizard/wizard-configs'
import { einClosureLetterLines } from '@/lib/closure/ein-closure-letter'
import { EIN_LETTER_BODY_CLOSE, EIN_LETTER_REQUEST, EIN_LETTER_TO } from '@/lib/closure/ein-letter-wording'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const GOOD = 'closure/6a2f0c1e-1111-4222-8333-444455556666/signature_image_ab12cd34_signature.png'
const ctx = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone)', now: new Date('2026-11-10T18:30:00Z') }

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** What the wizard submits: the answers, the drawing, and the fingerprint of the letter the client saw (what the signature box sends). */
function submitted(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const data: Record<string, unknown> = { llc_name: 'X LLC', llc_ein: '12-3456789', owner_first_name: 'Ann', owner_last_name: 'Lee', [CLOSURE_SIGNATURE_FIELD]: [GOOD], ...extra }
  if (!('signature_seen' in extra)) data.signature_seen = signatureFingerprint(data)
  return data
}

describe('applyClosureSignatureConsent — the server owns the consent record', () => {
  it('records the consent text, time, address and browser for a client who drew a signature', () => {
    const data = submitted()
    expect(applyClosureSignatureConsent(data, ctx)).toEqual({ signed: true })
    expect(data[CLOSURE_SIGNATURE_FIELD]).toEqual([GOOD])
    expect(data.signature_consent).toBe(CLOSURE_SIGNATURE_CONSENT_EN)
    expect(data.signature_consent_locale).toBe('en')
    expect(data.signature_signed_at).toBe('2026-11-10T18:30:00.000Z')
    expect(data.signature_ip).toBe('203.0.113.7')
    expect(data.signature_user_agent).toBe('Mozilla/5.0 (iPhone)')
    expect(data.signature_for).toBe('x|123456789|ann lee') // what the server saw submitted: the letter maker compares it with the letter
    expect(data.llc_name).toBe('X LLC') // the other answers are untouched
    expect('signature_seen' in data).toBe(false) // the client's hint is consumed
  })

  it('records the Italian text when the client saw the Italian wizard, and removes the language hint', () => {
    const data = submitted({ signature_locale: 'it' })
    applyClosureSignatureConsent(data, ctx)
    expect(data.signature_consent).toBe(CLOSURE_SIGNATURE_CONSENT_IT)
    expect(data.signature_consent_locale).toBe('it')
    expect('signature_locale' in data).toBe(false)
  })

  it('throws away a consent record the client sent for themselves, and records nothing without a signature', () => {
    const forged: Record<string, unknown> = { signature_consent: 'anything', signature_signed_at: '2020-01-01', signature_ip: '1.1.1.1', signature_user_agent: 'x', signature_consent_locale: 'it', signature_for: 'a|b|c', signature_seen: 'x' }
    expect(applyClosureSignatureConsent(forged, ctx)).toEqual({ signed: false })
    expect(Object.keys(forged)).toEqual([])
  })

  it('a forged record next to a real signature is replaced by the server’s own values', () => {
    const data = submitted({ signature_consent: 'FORGED', signature_signed_at: '1999-01-01T00:00:00.000Z', signature_ip: '6.6.6.6', signature_user_agent: 'FORGED-AGENT', signature_consent_locale: 'xx', signature_for: 'forged|forged|forged' })
    expect(applyClosureSignatureConsent(data, ctx)).toEqual({ signed: true })
    expect(data.signature_consent).toBe(CLOSURE_SIGNATURE_CONSENT_EN)
    expect([data.signature_signed_at, data.signature_ip, data.signature_user_agent, data.signature_consent_locale, data.signature_for]).toEqual(['2026-11-10T18:30:00.000Z', '203.0.113.7', 'Mozilla/5.0 (iPhone)', 'en', 'x|123456789|ann lee'])
  })

  it('refuses a signature drawn for other company details than the ones sent (changed after signing, or an old tab that sends no hint)', () => {
    const changed = submitted()
    changed.llc_name = 'Other LLC' // the client went back a step and changed it after drawing
    expect(applyClosureSignatureConsent(changed, ctx)).toEqual({ signed: false, changedAfterSigning: true })
    expect(CLOSURE_SIGNATURE_FIELD in changed).toBe(false)
    expect('signature_consent' in changed).toBe(false)
    const noHint = submitted()
    delete noHint.signature_seen
    expect(applyClosureSignatureConsent(noHint, ctx)).toEqual({ signed: false, changedAfterSigning: true })
    const einChanged = submitted()
    einChanged.llc_ein = '99-9999999'
    expect(applyClosureSignatureConsent(einChanged, ctx).signed).toBe(false)
  })

  it('a different spelling of the same company or EIN is still the same letter', () => {
    const data = submitted({ llc_name: 'Café & Co, L.L.C.', llc_ein: '12-3456789' })
    data.signature_seen = signatureFingerprint({ ...data, llc_name: 'cafe and co llc', llc_ein: '123456789' })
    expect(applyClosureSignatureConsent(data, ctx).signed).toBe(true)
  })

  it('only accepts a path the wizard minted for this field (no other file, no path tricks)', () => {
    for (const bad of ['closure/x/ein_letter_ab12cd34_signature.png', '../signature_image_x', 'signature_image_ab12cd34_x.png', 'closure/a/b/signature_image_x.png', 'formation/x/signature_image_ab12cd34_s.png', 42, null, {}]) {
      const data = submitted({ [CLOSURE_SIGNATURE_FIELD]: [bad] })
      expect(applyClosureSignatureConsent(data, ctx).signed).toBe(false)
      expect(CLOSURE_SIGNATURE_FIELD in data).toBe(false)
    }
    expect(signaturePathsOf(GOOD)).toEqual([GOOD]) // a single string value counts too
  })

  it('keeps only the LAST drawing when there are several', () => {
    const second = GOOD.replace('ab12cd34', 'ee99ff00')
    const data = submitted({ [CLOSURE_SIGNATURE_FIELD]: [GOOD, second] })
    applyClosureSignatureConsent(data, ctx)
    expect(data[CLOSURE_SIGNATURE_FIELD]).toEqual([second])
  })

  it('cuts a very long browser string', () => {
    const data = submitted()
    applyClosureSignatureConsent(data, { ...ctx, userAgent: 'x'.repeat(1000) })
    expect(String(data.signature_user_agent)).toHaveLength(300)
  })
})

describe('company comparison used by the signature', () => {
  it('names match across case, punctuation, accents and the company suffix', () => {
    expect(normalizeCompanyName('ZZQA Prod Città & Café Test LLC')).toBe(normalizeCompanyName('zzqa prod citta and cafe test, L.L.C.'))
    expect(normalizeCompanyName('Acme Inc.')).toBe(normalizeCompanyName('ACME'))
    expect(normalizeCompanyName('Acme LLC')).not.toBe(normalizeCompanyName('Acme Holdings LLC'))
    expect(normalizeCompanyName(null)).toBe('')
  })
  it('an EIN is nine digits however it is written', () => {
    expect(einDigits('88-7700001')).toBe('887700001')
    expect(einDigits(' 887700001 ')).toBe('887700001')
    expect(einDigits('88-770000')).toBe('')
    expect(einDigits(12)).toBe('')
  })
  it('two letters agree only when the company AND the EIN agree', () => {
    expect(sameSignedCompany('acme|123456789|a', 'acme|123456789|')).toBe(true)
    expect(sameSignedCompany('acme|123456789|a', 'acme|999999999|')).toBe(false)
    expect(sameSignedCompany('acme|123456789|a', 'beta|123456789|')).toBe(false)
    expect(sameSignedCompany('acme||a', 'acme||')).toBe(false) // no EIN = never a match
  })
})

describe('what staff and the duplicate check see', () => {
  const stored = { llc_name: 'X LLC', signature_image: [GOOD], signature_consent: 'text', signature_consent_locale: 'it', signature_signed_at: '2026-11-10T19:24:20.158Z', signature_ip: '1.2.3.4', signature_user_agent: 'UA', signature_for: 'x|1|a' }
  it('staff read one plain line instead of the technical consent record', () => {
    const shown = presentClosureAnswers(stored) as Record<string, unknown>
    expect(Object.keys(shown).filter((k) => k.startsWith('signature_')).sort()).toEqual(['signature_drawn', 'signature_image'])
    expect(shown.signature_drawn).toBe('Yes — drawn by the client on Nov 10, 2026 (consent shown in Italian)')
    expect(stored.signature_ip).toBe('1.2.3.4') // the stored answers are not touched
  })
  it('answers without a consent record get no such line, and non-objects pass through', () => {
    expect((presentClosureAnswers({ llc_name: 'X' }) as Record<string, unknown>).signature_drawn).toBeUndefined()
    expect(presentClosureAnswers(null)).toBeNull()
    expect(presentClosureAnswers('x')).toBe('x')
  })
  it('the duplicate-send check ignores the server’s own record (its clock differs on every send)', () => {
    const a = withoutSignatureRecord({ ...stored, signature_signed_at: '2026-11-10T19:24:20Z' })
    const b = withoutSignatureRecord({ ...stored, signature_signed_at: '2026-11-10T19:24:25Z' })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect('signature_ip' in a).toBe(false)
    expect((a as Record<string, unknown>).llc_name).toBe('X LLC')
  })
})

describe('PNG size from the header', () => {
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33)
    b.set(PNG_HEAD, 0)
    new DataView(b.buffer).setUint32(16, w)
    new DataView(b.buffer).setUint32(20, h)
    return b
  }
  it('reads width and height, and refuses what is not a PNG or has no size', () => {
    expect(readPngSize(png(400, 160))).toEqual({ width: 400, height: 160 })
    expect(readPngSize(png(0, 5))).toBeNull()
    expect(readPngSize(Uint8Array.from(Buffer.from('%PDF-1.7 not a picture at all, long enough')))).toBeNull()
    expect(readPngSize(new Uint8Array(10))).toBeNull()
    expect(MAX_SIGNATURE_PIXELS).toBe(4000)
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
    expect(preview).toContain('signatureFingerprint') // the box signs for the details above it
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
    expect(c).toContain('CLOSURE_SIGNATURE_SEEN_HINT') // which letter was signed: the server compares it with what is sent
    expect(c).toContain("new File([blob], 'signature.png'")
  })

  it('the submit route verifies the picture, then writes the consent record for a closure, before the answers are stored', () => {
    const route = read('app/api/portal/wizard-submit/route.ts')
    const at = route.indexOf('applyClosureSignatureConsent(closureData')
    expect(at).toBeGreaterThan(0)
    expect(route).toContain("wizard_type === 'closure' && (typeof data !== 'object'") // answers that are not an object are refused, not stored
    expect(route.indexOf('verifyClosureSignatureFile(')).toBeGreaterThan(0)
    expect(route.indexOf('verifyClosureSignatureFile(')).toBeLessThan(at)
    expect(route).toContain("identity.kind !== 'contact'") // only the owner signs
    expect(at).toBeLessThan(route.indexOf('buildSubmissionRecord(submissionTable'))
  })

  it('the duplicate-send check is computed without the server’s own consent record', () => {
    expect(read('app/api/portal/wizard-submit/route.ts')).toContain('data: withoutSignatureRecord(data)')
  })

  it('the server refuses a closure sent without a valid signature, with a plain sentence in both languages (the wizard gate stops it first)', () => {
    const route = read('app/api/portal/wizard-submit/route.ts')
    expect(route).toContain('if (!sig.signed)')
    expect(route).toContain('Please draw your signature for the EIN letter before sending the closure form.')
    expect(route).toContain('Disegna la tua firma per la lettera EIN')
    expect(route).toMatch(/!sig\.signed\)[\s\S]{0,900}status: 400/)
  })

  it('the emailed-link closure form cannot write the consent record or a signature', () => {
    const legacy = read('app/api/closure-form/[token]/data/route.ts')
    expect(legacy).toContain('CLOSURE_SIGNATURE_RECORD_KEYS')
    expect(legacy).toContain('CLOSURE_SIGNATURE_FIELD')
    expect(legacy).toContain('submitted_data: submittedData')
  })

  it('staff read the tidy answers', () => {
    expect(read('app/api/flows/[id]/submission/route.ts')).toContain('presentClosureAnswers(cs.submitted_data')
  })
})
