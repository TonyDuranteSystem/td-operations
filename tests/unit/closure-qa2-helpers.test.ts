import { describe, it, expect } from 'vitest'
import { stagingFileName } from '@/lib/storage/staging-name'
import { uploadContentProblem } from '@/lib/flows/upload-content-check'
import { wizardFileTypeProblem, WIZARD_DOCUMENT_FIELDS } from '@/lib/portal/wizard-file-rules'
import { trackingNumberProblem } from '@/lib/flows/tracking-number'
import { einDifferenceNote, decideClosureTarget, matchTypedCompany } from '@/lib/forms/closure-destination'
import { dropForeignUploadPaths } from '@/lib/portal/wizard-uploads'
import { applyClosureSignatureConsent, signatureFingerprint, CLOSURE_SIGNATURE_FIELD } from '@/lib/closure/signature-consent'

describe('stagingFileName — a name the storage key accepts (QA F8)', () => {
  it('leaves a plain name alone', () => {
    expect(stagingFileName('State confirmation.pdf')).toBe('State_confirmation.pdf')
    expect(stagingFileName('ricevuta-2026_final.PDF')).toBe('ricevuta-2026_final.PDF')
  })
  it('cleans the characters the storage refuses (% ? # accents Japanese)', () => {
    expect(stagingFileName('Ricevuta città 50%.pdf')).toBe('Ricevuta_citta_50.pdf')
    expect(stagingFileName('what?.pdf')).toBe('what.pdf')
    expect(stagingFileName('a#b%c.pdf')).toBe('a_b_c.pdf')
    expect(stagingFileName('café.pdf')).toBe('cafe.pdf')
  })
  it('a name made only of unusable characters keeps its extension', () => {
    expect(stagingFileName('日本語.pdf')).toBe('file.pdf')
    expect(stagingFileName('???.PNG')).toBe('file.PNG')
    expect(stagingFileName('日本語')).toBe('file')
  })
  it('never produces a character outside the safe set', () => {
    for (const n of ['%', '?', '#', '../../etc/passwd', 'a/b\\c.pdf', 'tab\there.pdf', 'emoji 😀.png', '']) {
      expect(stagingFileName(n)).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })
  it('keeps the end and the extension of a very long name', () => {
    const out = stagingFileName(`${'x'.repeat(300)}_page2.pdf`)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith('_page2.pdf')).toBe(true)
  })
})

describe('uploadContentProblem — an empty or fake PDF is never saved (QA F2)', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')
  it('accepts a real PDF, a picture and a PDF with a few junk bytes in front', () => {
    expect(uploadContentProblem({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: pdf })).toBeNull()
    expect(uploadContentProblem({ fileName: 'a.png', mimeType: 'image/png', bytes: Buffer.from([1, 2, 3]) })).toBeNull()
    expect(uploadContentProblem({ fileName: 'a.pdf', bytes: Buffer.concat([Buffer.from('\n\n  '), pdf]) })).toBeNull()
  })
  it('refuses an empty file, whatever its name', () => {
    expect(uploadContentProblem({ fileName: 'empty.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(0) })).toMatch(/empty/)
    expect(uploadContentProblem({ fileName: 'empty.png', bytes: Buffer.alloc(0) })).toMatch(/empty/)
  })
  it('refuses a text file renamed .pdf and a pdf-typed file with no PDF inside', () => {
    expect(uploadContentProblem({ fileName: 'x.pdf', bytes: Buffer.from('hello, this is text') })).toMatch(/not a real PDF/)
    expect(uploadContentProblem({ fileName: 'x', mimeType: 'application/pdf', bytes: Buffer.from('<html></html>') })).toMatch(/not a real PDF/)
  })
})

describe('wizardFileTypeProblem — the Articles take a document or a picture (QA F1)', () => {
  it('refuses a .txt in the Articles / EIN letter / passport boxes, bilingual', () => {
    for (const f of ['articles_of_organization', 'ein_letter', 'passport_owner']) {
      const msg = wizardFileTypeProblem(f, 'notes.txt')
      expect(msg).toMatch(/PDF/)
      expect(msg).toMatch(/Questo campo/)
    }
    expect(wizardFileTypeProblem('articles_of_organization', 'run.exe')).not.toBeNull()
    expect(wizardFileTypeProblem('ein_letter', 'bundle.zip')).not.toBeNull()
  })
  it('accepts documents, phone photos and scans (any case)', () => {
    for (const n of ['a.pdf', 'A.PDF', 'photo.HEIC', 'p.jpg', 'p.JPEG', 'scan.tiff', 'x.docx', 'x.webp']) {
      expect(wizardFileTypeProblem('articles_of_organization', n)).toBeNull()
    }
  })
  it('lets a name with no extension through, and leaves the other boxes open', () => {
    expect(wizardFileTypeProblem('ein_letter', 'scan')).toBeNull()
    expect(wizardFileTypeProblem('other_documents', 'notes.txt')).toBeNull()
    expect(wizardFileTypeProblem('proof_of_address', 'bill.txt')).toBeNull()
  })
  it('guards exactly the documented boxes', () => {
    expect([...WIZARD_DOCUMENT_FIELDS].sort()).toEqual(['articles_of_organization', 'ein_letter', 'member_passport', 'passport_image', 'passport_owner', 'ss4_form'])
  })
})

describe('trackingNumberProblem — a made-up number is refused (QA F7)', () => {
  it('refuses "abc" and other junk for every courier', () => {
    for (const c of ['USPS', 'UPS', 'FedEx', 'DHL', 'Other']) {
      expect(trackingNumberProblem(c, 'abc')).not.toBeNull()
      expect(trackingNumberProblem(c, '')).not.toBeNull()
      expect(trackingNumberProblem(c, '11111111111111')).not.toBeNull()
      expect(trackingNumberProblem(c, 'hello world!!')).not.toBeNull()
      expect(trackingNumberProblem(c, 'abcdefgh')).not.toBeNull()
    }
  })
  it('accepts real shapes for each courier (spaces and dashes ignored)', () => {
    expect(trackingNumberProblem('USPS', '9400111899223344556677')).toBeNull()
    expect(trackingNumberProblem('USPS', '9400 1118 9922 3344 5566 77')).toBeNull()
    expect(trackingNumberProblem('USPS', 'EA123456789US')).toBeNull()
    expect(trackingNumberProblem('UPS', '1Z999AA10123456784')).toBeNull()
    expect(trackingNumberProblem('FedEx', '123456789012')).toBeNull()
    expect(trackingNumberProblem('FedEx', '123456789012345')).toBeNull()
    expect(trackingNumberProblem('DHL', '1234567890')).toBeNull()
    expect(trackingNumberProblem('DHL', 'JJD0123456789')).toBeNull()
    expect(trackingNumberProblem('Other', 'RR123456785IT')).toBeNull()
  })
  it('catches a number typed under the wrong courier, with a sentence that says what to do', () => {
    const msg = trackingNumberProblem('UPS', '9400111899223344556677')
    expect(msg).toMatch(/does not look like a UPS/)
    expect(msg).toMatch(/Other/)
  })
})

describe('einDifferenceNote — only for a company of ours with a different 9-digit EIN (the other mode is untouched)', () => {
  const ours = { id: 'a', company_name: 'Acme LLC', ein_number: '88-7710002' }
  it('says so when the client wrote a different EIN for our company', () => {
    const note = einDifferenceNote({ typedEin: '88-7719999', linked: ours })
    expect(note).toMatch(/88-7719999/)
    expect(note).toMatch(/88-7710002/)
    expect(note).not.toMatch(/CHECK:/)
  })
  it('says nothing when the EIN agrees however it was typed', () => {
    expect(einDifferenceNote({ typedEin: '887710002', linked: ours })).toBeNull()
    expect(einDifferenceNote({ typedEin: '88 7710002', linked: ours })).toBeNull()
  })
  it('says nothing for a job with NO company of ours (any EIN is simply what the client wrote)', () => {
    expect(einDifferenceNote({ typedEin: '12-3456789', linked: null })).toBeNull()
    expect(einDifferenceNote({ typedEin: '12-3456789', linked: undefined })).toBeNull()
  })
  it('says nothing when our record has no EIN, or the client typed an unfinished number', () => {
    expect(einDifferenceNote({ typedEin: '12-3456789', linked: { ...ours, ein_number: null } })).toBeNull()
    expect(einDifferenceNote({ typedEin: '12-3456', linked: ours })).toBeNull()
  })
  it('a non-client closure still files in the person folder with no disagreement and no hold', () => {
    const match = matchTypedCompany({ name: 'Somebody Else LLC', ein: '12-3456789' }, [ours])
    expect(match.status).toBe('none')
    const t = decideClosureTarget({ linkedAccountId: null, match })
    expect(t).toEqual({ kind: 'other_company', disagreement: null })
  })
})

describe('dropForeignUploadPaths — a file in someone else folder is not this client upload (hunter #12)', () => {
  const own = ['acct-1', 'contact-9']
  it('removes foreign paths from any field, keeps the sender own files', () => {
    const data: Record<string, unknown> = {
      llc_name: 'closure/victim-id/articles_of_organization_ab12cd34_secret.pdf', // typed into a TEXT box
      articles_of_organization: ['closure/acct-1/articles_of_organization_11111111_a.pdf', 'closure/victim-id/ein_letter_22222222_b.pdf'],
      ein_letter: 'closure/contact-9/ein_letter_33333333_e.pdf',
      notes: 'plain text',
    }
    const dropped = dropForeignUploadPaths(data, own)
    expect(dropped.sort()).toEqual(['closure/victim-id/articles_of_organization_ab12cd34_secret.pdf', 'closure/victim-id/ein_letter_22222222_b.pdf'])
    expect(data.llc_name).toBe('')
    expect(data.articles_of_organization).toEqual(['closure/acct-1/articles_of_organization_11111111_a.pdf'])
    expect(data.ein_letter).toBe('closure/contact-9/ein_letter_33333333_e.pdf')
    expect(data.notes).toBe('plain text')
  })
  it('treats a traversal path as foreign and ignores values that are not wizard paths', () => {
    const data: Record<string, unknown> = { a: 'closure/acct-1/../victim/x.pdf', b: 'tax/other/x.pdf', c: 'hello', d: 5, e: null }
    const dropped = dropForeignUploadPaths(data, own)
    expect(dropped).toEqual(['closure/acct-1/../victim/x.pdf', 'tax/other/x.pdf'])
    expect(data.c).toBe('hello')
    expect(data.d).toBe(5)
  })
})

describe('consent language on an unchanged re-send (QA F9)', () => {
  const GOOD = 'closure/6a2f0c1e-1111-4222-8333-444455556666/signature_image_ab12cd34_signature.png'
  const ctx = { ip: '1.2.3.4', userAgent: 'UA', now: new Date('2026-11-10T18:30:00Z') }
  function resend(extra: Record<string, unknown>): Record<string, unknown> {
    const data: Record<string, unknown> = { llc_name: 'X LLC', llc_ein: '12-3456789', owner_first_name: 'Ann', owner_last_name: 'Lee', [CLOSURE_SIGNATURE_FIELD]: [GOOD], ...extra }
    data.signature_for = signatureFingerprint(data)
    return data
  }
  it('uses the hint the box sends', () => {
    const d = resend({ signature_locale: 'it' })
    expect(applyClosureSignatureConsent(d, ctx).signed).toBe(true)
    expect(d.signature_consent_locale).toBe('it')
  })
  it('with no hint, keeps the language recorded the first time instead of switching to English', () => {
    const d = resend({ signature_consent_locale: 'it' })
    expect(applyClosureSignatureConsent(d, ctx).signed).toBe(true)
    expect(d.signature_consent_locale).toBe('it')
  })
  it('with neither, English; and a hint beats the old record', () => {
    const a = resend({})
    applyClosureSignatureConsent(a, ctx)
    expect(a.signature_consent_locale).toBe('en')
    const b = resend({ signature_consent_locale: 'it', signature_locale: 'en' })
    applyClosureSignatureConsent(b, ctx)
    expect(b.signature_consent_locale).toBe('en')
  })
})
