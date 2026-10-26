import { describe, it, expect } from 'vitest'
import { validateContractWording, wordingFromSnapshot, WORDING_LIMITS, parseInline, stripInline, dutyFromLine, dutyToLine, toEditable, editableToWording } from '@/lib/contracts/contract-wording'

type Fail = { errors: string[]; fields: Record<string, string[]>; error: string; details?: string[] }

const good = () => ({
  title: 'Apostille Service Agreement',
  shortTitle: 'Apostille Service Agreement',
  pdfPrefix: 'Apostille_Agreement',
  scope: { intro: 'The Service Provider agrees to obtain an apostille. This includes:', items: ['Checking the document;', 'Submitting it.'], closing: 'This Agreement covers one (1) apostille only.' },
  procedure: { intro: 'The apostille follows these steps:', steps: [{ title: 'Step 1', desc: 'The Client sends the document.' }, { title: 'Step 2', desc: 'We submit it.' }] },
  commitments: ['Submit the document promptly;', 'Return the apostilled document.'],
  clientDuties: { intro: 'The Client agrees to:', items: [{ bold: 'Send a legible document', rest: ';' }, { bold: 'Respond within five business days', rest: '.' }] },
  signatureText: 'By signing below, I confirm that I have read and agree to the terms of this Apostille Service Agreement.',
  successNote: 'Once payment is received, we will begin the apostille.',
  workPhrase: 'the apostille',
  liabilityPhrase: 'the acceptance of the document by any authority, or for consequences',
})

describe('validateContractWording', () => {
  it('accepts a complete wording and returns it clean', () => {
    const r = validateContractWording(good())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.wording.title).toBe('Apostille Service Agreement')
  })

  it('the work and liability phrases are required (the page would fall back to the TAX-RETURN sentence without them)', () => {
    for (const key of ['workPhrase', 'liabilityPhrase']) {
      const w: Record<string, unknown> = good()
      delete w[key]
      const r = validateContractWording(w)
      expect(r.ok, key).toBe(false)
      if (!r.ok) expect((r as unknown as Fail).fields[key]).toBeTruthy()
    }
  })

  it('trims text and ignores unknown extra fields', () => {
    const r = validateContractWording({ ...good(), title: '  Padded  ', evil: 'x' })
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.wording.title).toBe('Padded'); expect((r.wording as unknown as Record<string, unknown>).evil).toBeUndefined() }
  })

  it('refuses a missing or empty required part and says which', () => {
    const w = good() as Record<string, unknown>
    delete w.signatureText
    w.commitments = []
    const r = validateContractWording(w)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect((r as unknown as Fail).errors.join(' | ')).toContain('Acceptance sentence is missing')
      expect((r as unknown as Fail).errors.join(' | ')).toContain('Service Provider commitments needs at least one entry')
    }
  })

  it('refuses anything that is not an object, and wrong shapes', () => {
    for (const bad of [null, undefined, 'text', 42, [], { title: 'x' }]) expect(validateContractWording(bad).ok, String(bad)).toBe(false)
    const r = validateContractWording({ ...good(), scope: 'nope' })
    expect(r.ok).toBe(false)
  })

  it('refuses markup anywhere: < and > are never allowed (plain text only)', () => {
    for (const evil of ['<script>alert(1)</script>', 'a <b>bold</b> claim', '1 > 0']) {
      const w = good()
      w.successNote = evil
      expect(validateContractWording(w).ok, evil).toBe(false)
    }
    const w2 = good(); w2.scope.items = ['fine', '<img src=x onerror=alert(1)>']
    const r = validateContractWording(w2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r as unknown as Fail).errors.join(' ')).toContain('Scope items #2')
  })

  it('enforces length and list-size limits', () => {
    const w = good(); w.title = 'x'.repeat(WORDING_LIMITS.title + 1)
    expect(validateContractWording(w).ok).toBe(false)
    const w2 = good(); w2.commitments = Array.from({ length: WORDING_LIMITS.items + 1 }, (_, i) => `item ${i}`)
    expect(validateContractWording(w2).ok).toBe(false)
    const w3 = good(); w3.scope.intro = 'y'.repeat(WORDING_LIMITS.paragraph + 1)
    expect(validateContractWording(w3).ok).toBe(false)
  })

  it('the PDF file-name stem uses only letters, numbers and underscores', () => {
    for (const bad of ['has space', '../evil', 'a/b', 'dot.pdf']) {
      const w = good(); w.pdfPrefix = bad
      expect(validateContractWording(w).ok, bad).toBe(false)
    }
  })

  it('a client duty may have an empty "rest" (just the bold part)', () => {
    const w = good(); w.clientDuties.items = [{ bold: 'Provide accurate information.', rest: '' }]
    expect(validateContractWording(w).ok).toBe(true)
  })
})

describe('wordingFromSnapshot — what the contract page reads', () => {
  const snap = (content: unknown) => ({ custom_apostille: { version: 2, hash: 'abc', content, snapshot_at: '2026-10-26T00:00:00Z' } })
  it('returns the validated wording for the type', () => {
    expect(wordingFromSnapshot(snap(good()), 'custom_apostille')?.title).toBe('Apostille Service Agreement')
  })
  it('null when the copy is missing, for another type, malformed or not valid wording', () => {
    expect(wordingFromSnapshot(null, 'custom_apostille')).toBeNull()
    expect(wordingFromSnapshot({}, 'custom_apostille')).toBeNull()
    expect(wordingFromSnapshot(snap(good()), 'custom_other')).toBeNull()
    expect(wordingFromSnapshot('text', 'custom_apostille')).toBeNull()
    expect(wordingFromSnapshot([], 'custom_apostille')).toBeNull()
    expect(wordingFromSnapshot(snap({ title: 'only a title' }), 'custom_apostille')).toBeNull()
    expect(wordingFromSnapshot({ custom_apostille: 'str' }, 'custom_apostille')).toBeNull()
  })
})


describe('errors come back keyed by the line they belong to (the editor shows each next to its line)', () => {
  it('keys list entries by position and steps by field', () => {
    const w = good()
    w.scope.items = ['fine', '<b>x</b>']
    w.procedure.steps = [{ title: '', desc: 'ok' }, { title: 'T', desc: 'a > b' }]
    w.commitments = ['ok', '']
    const r = validateContractWording(w)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(Object.keys((r as unknown as Fail).fields).sort()).toEqual(['commitments.1', 'procedure.steps.0.title', 'procedure.steps.1.desc', 'scope.items.1'].sort())
      expect((r as unknown as Fail).fields['scope.items.1'][0]).toContain('Scope items #2')
    }
  })
  it('a list that is empty or too long is reported on the list itself', () => {
    const w = good(); w.commitments = []
    const r = validateContractWording(w)
    expect(!r.ok && (r as unknown as Fail).fields['commitments']).toBeTruthy()
  })
  it('a client duty problem is keyed to the single duty line', () => {
    const w = good(); w.clientDuties.items = [{ bold: '', rest: 'x' }]
    const r = validateContractWording(w)
    expect(!r.ok && (r as unknown as Fail).fields['clientDuties.items.0']).toBeTruthy()
  })
})

describe('**bold** marks', () => {
  it('parseInline splits on paired marks and keeps a lone mark as text', () => {
    expect(parseInline('plain')).toEqual([{ text: 'plain', bold: false }])
    expect(parseInline('a **b** c')).toEqual([{ text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false }])
    expect(parseInline('**b** c')).toEqual([{ text: 'b', bold: true }, { text: ' c', bold: false }])
    expect(parseInline('a **b**')).toEqual([{ text: 'a ', bold: false }, { text: 'b', bold: true }])
    expect(parseInline('a **b** c **d** e').map((x) => x.bold)).toEqual([false, true, false, true, false])
    expect(parseInline('a ** b')).toEqual([{ text: 'a ** b', bold: false }])
    expect(parseInline('a **b** c ** d')).toEqual([{ text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c ** d', bold: false }])
    expect(parseInline('')).toEqual([{ text: '', bold: false }])
  })
  it('stripInline shows what a reader sees', () => {
    expect(stripInline('Send **a complete** document')).toBe('Send a complete document')
  })
  it('is accepted on the lines that can carry it', () => {
    const w = good()
    w.scope.items = ['Check **the document**;']
    w.commitments = ['Return **the apostilled document**.']
    w.procedure.steps = [{ title: 'Step 1', desc: 'We **submit** it.' }]
    w.clientDuties.items = [{ bold: 'Send a document', rest: ' that is **complete**;' }]
    expect(validateContractWording(w).ok).toBe(true)
  })
  it('is refused where it cannot work: titles, the closing sentence, the acceptance sentence, the after-signing message, the phrases', () => {
    const cases: Array<(w: ReturnType<typeof good>) => void> = [
      (w) => { w.title = 'A **b** Agreement' },
      (w) => { w.scope.closing = 'Only **one**.' },
      (w) => { w.signatureText = 'I **agree**.' },
      (w) => { w.successNote = 'We **begin**.' },
      (w) => { w.workPhrase = 'the **apostille**' },
      (w) => { w.procedure.steps = [{ title: 'S **1**', desc: 'ok' }] },
      (w) => { w.clientDuties.items = [{ bold: 'Send **x**', rest: ';' }] },
    ]
    cases.forEach((mut, i) => { const w = good(); mut(w); expect(validateContractWording(w).ok, `case ${i}`).toBe(false) })
  })
  it('refuses an unpaired mark and empty bold', () => {
    for (const bad of ['a ** b', 'a **b** c **d', 'a **** b', 'a ** ** b']) {
      const w = good(); w.scope.items = [bad]
      expect(validateContractWording(w).ok, bad).toBe(false)
    }
  })
})

describe('client duties as one editable line', () => {
  it('round-trips between { bold, rest } and "**bold**rest"', () => {
    const d = { bold: 'Respond to requests', rest: ' within five (5) business days;' }
    expect(dutyToLine(d)).toBe('**Respond to requests** within five (5) business days;')
    expect(dutyFromLine(dutyToLine(d))).toEqual(d)
  })
  it('a line without a leading bold part is not a duty', () => {
    expect(dutyFromLine('no bold here')).toBeNull()
    expect(dutyFromLine('****rest')).toBeNull()
    expect(dutyFromLine('x **late bold**')).toBeNull()
  })
  it('keeps the space after the bold heading (it separates the words) and never lets them glue', () => {
    const r = validateContractWording({ ...good(), clientDuties: { intro: 'The Client agrees to:', items: [{ bold: 'Send documents', rest: ' within 5 days' }, { bold: 'Reply', rest: 'quickly' }] } })
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.wording.clientDuties.items[0].rest).toBe(' within 5 days'); expect(r.wording.clientDuties.items[1].rest).toBe(' quickly') }
  })
  it('editableToWording converts lines back and reports a bad duty line on that line', () => {
    const ok = editableToWording(toEditable((validateContractWording(good()) as { ok: true; wording: never }).wording))
    expect(ok.ok).toBe(true)
    const e = toEditable((validateContractWording(good()) as { ok: true; wording: never }).wording)
    e.clientDuties.items = ['**Fine**;', 'no bold part']
    const r = editableToWording(e)
    expect(r.ok).toBe(false)
    if (!r.ok) { expect((r as unknown as Fail).fields['clientDuties.items.1']?.[0]).toContain('must start with a bold part'); expect((r as unknown as Fail).fields['clientDuties.items.0']).toBeUndefined() }
  })
})
